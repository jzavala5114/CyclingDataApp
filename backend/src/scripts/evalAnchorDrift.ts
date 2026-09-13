import "dotenv/config";
import { pool } from "../db/pool.js";
import { matchSamplesToSegments, stitchFragmentedRuns } from "../services/segmentMatcher.js";
import { assessRun } from "../services/elevationAggregator.js";
import { rejectElevationSpikes, smoothElevations } from "../services/elevationSmoothing.js";
import { demKey } from "../services/demElevation.js";
import { fitAnchor, type AnchorPoint } from "../services/anchorFit.js";
import { collectRevisits } from "../services/sessionProcessor.js";
import { isUsable, loadSessionVerdicts } from "../services/usableSessions.js";
import type { Direction, Segment, SessionSample } from "../types/index.js";

// Does the elevation model agree with itself?
//
//   npx tsx src/scripts/evalAnchorDrift.ts
//
// The eval behind the sliding anchor. Gate tests prove the fit does what it
// says on synthetic rides; this proves it helps on the real archive, which is
// the only place the failure was ever visible.
//
// Two questions, both asked at bucket level, because buckets are what the map
// draws. Asking them of raw session_samples measures the uncorrected data and
// would not move no matter what the anchor did -- the correction is applied on
// the way into a bucket, never back onto the sample rows.
//
//   Self-consistency  one ride, one bucket, two passes minutes apart. The rider
//                     cannot have changed the height of the ground between
//                     them, so any difference is the ride disagreeing with
//                     itself. This is the closest thing to a ground truth here
//                     because it needs no second ride and no terrain model.
//
//   Cross-ride        one bucket, two rides. What actually lands on the map,
//                     since the running mean blends them and a neighbouring
//                     bucket fed by a different mix lands somewhere else.
//
// Reads only. Writes nothing, and fetches no terrain: it uses the DEM values
// already cached in segment_dem_elevations, so a ride whose terrain was never
// fetched simply contributes fewer points, exactly as it would in a rebuild.

const BBOX_PAD_DEG = 0.005;
// Two passes closer together than this are really one traversal seen twice,
// and the barometer has had no time to move between them.
const MIN_REVISIT_GAP_S = 300;

type Mode = "before" | "after";
const MODES: Mode[] = ["before", "after"];

interface Observation {
  sessionId: number;
  atMs: number;
  elevationM: number;
}

// mode -> "segment|direction|distance" -> observations from every ride
const byMode = new Map<Mode, Map<string, Observation[]>>(MODES.map((m) => [m, new Map()]));
const ramped = new Map<Mode, number>(MODES.map((m) => [m, 0]));
const unanchored = new Map<Mode, number>(MODES.map((m) => [m, 0]));
const driftSeen: number[] = [];
// Which rides the change actually touched. Every other ride's buckets come out
// bit-for-bit identical, so a whole-archive average is mostly comparisons the
// change never reached, and it dilutes the effect towards nothing.
const treated = new Set<number>();
// The rides production would ramp, fitting on every revisit rather than on the
// half this eval keeps. Always a superset of `treated`.
const productionRamped = new Set<number>();
const perRide: Record<string, unknown>[] = [];
// session -> the bucket keys withheld from that session's drift fit. Self
// consistency is scored only on these, so it is out of sample.
const heldOutKeys = new Map<number, Set<string>>();

const verdicts = await loadSessionVerdicts(pool);
const usable = verdicts.filter(isUsable);
console.log(`measuring ${usable.length} sessions\n`);

for (const session of usable) {
  const { rows: samples } = await pool.query<SessionSample>(
    `select id, recorded_at as "recordedAt", lat, lon, elevation_m as "elevationM",
            heading_deg as "headingDeg", speed_mps as "speedMps", accuracy_m as "accuracyM"
       from session_samples where session_id = $1 order by recorded_at`,
    [session.id],
  );
  if (samples.length === 0) continue;

  const lats = samples.map((s) => s.lat);
  const lons = samples.map((s) => s.lon);
  const { rows: segmentRows } = await pool.query<Segment>(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            piece_index as "pieceIndex",
            ST_AsGeoJSON(geom)::json as geom, length_m as "lengthM", bearing_deg as "bearingDeg"
       from segments
      where canonical_segment_id is null
        and geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)`,
    [
      Math.min(...lons) - BBOX_PAD_DEG, Math.min(...lats) - BBOX_PAD_DEG,
      Math.max(...lons) + BBOX_PAD_DEG, Math.max(...lats) + BBOX_PAD_DEG,
    ],
  );

  const { kept } = rejectElevationSpikes(samples);
  const smoothed = smoothElevations(kept);
  const segmentsById = new Map(segmentRows.map((s) => [s.id, s]));
  const orderById = new Map(smoothed.map((s, i) => [s.id, i]));

  const qualifying: Array<{
    segmentId: number; direction: Direction; atMs: number;
    buckets: Array<{ distanceM: number; elevationM: number }>;
  }> = [];

  for (const run of stitchFragmentedRuns(matchSamplesToSegments(smoothed, segmentRows))) {
    const segment = segmentsById.get(run.segmentId);
    if (!segment) continue;
    const firstIndex = orderById.get(run.samples[0].id) ?? 0;
    const lastIndex = orderById.get(run.samples[run.samples.length - 1].id) ?? 0;
    const assessment = assessRun(run, segment, {
      before: firstIndex > 0 ? smoothed[firstIndex - 1] : undefined,
      after: lastIndex < smoothed.length - 1 ? smoothed[lastIndex + 1] : undefined,
    });
    if (!assessment.qualified) continue;
    const startedMs = Date.parse(run.samples[0].recordedAt);
    const endedMs = Date.parse(run.samples[run.samples.length - 1].recordedAt);
    qualifying.push({
      segmentId: segment.id,
      direction: run.direction,
      atMs: (startedMs + endedMs) / 2,
      buckets: assessment.profile.buckets,
    });
  }
  if (qualifying.length === 0) continue;

  const { rows: demRows } = await pool.query<{ key: string; elevationM: number }>(
    `select segment_id || '|' || direction || '|' || distance_m as key,
            elevation_m as "elevationM"
       from segment_dem_elevations where segment_id = any($1)`,
    [qualifying.map((r) => r.segmentId)],
  );
  const dem = new Map(demRows.map((r) => [r.key, r.elevationM]));

  const points: AnchorPoint[] = [];
  for (const run of qualifying) {
    for (const bucket of run.buckets) {
      const reference = dem.get(
        demKey({ segmentId: run.segmentId, direction: run.direction as never, distanceM: bucket.distanceM }),
      );
      if (reference == null) continue;
      points.push({ atMs: run.atMs, residualM: bucket.elevationM - reference });
    }
  }

  // Hold half the ride's revisited ground out of the fit.
  //
  // Without this the eval grades itself. The drift rate is fitted to revisit
  // pairs and self-consistency is measured on revisit pairs, so if they are the
  // same pairs then shrinking them is arithmetic, not evidence. Splitting the
  // revisited buckets by a stable hash of their key puts the fit on one half
  // and the measurement on the other, and the two halves are the same ride, so
  // a real drift correction still has to generalise across them.
  const heldOut = (key: string) => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return (h & 1) === 1;
  };
  const forFitting = qualifying.map((run) => ({
    ...run,
    buckets: run.buckets.filter(
      (b) => !heldOut(`${run.segmentId}|${run.direction}|${b.distanceM}`),
    ),
  }));
  const revisits = collectRevisits(forFitting);

  // What SHIPS sees, as opposed to what is measured here. Production fits on
  // every revisit; this eval fits on half of them so the other half can score
  // it out of sample. So the eval is handicapped, and the count of rides it
  // ramps is a floor on the real one, not the real one. Reporting the measured
  // count alone would understate the change's reach and quietly mis-state its
  // blast radius, since the identical-bucket proof below covers only the rides
  // the EVAL left alone.
  if (fitAnchor(points, collectRevisits(qualifying))?.shape === "ramp") {
    productionRamped.add(session.id);
  }
  heldOutKeys.set(
    session.id,
    new Set(
      qualifying.flatMap((run) =>
        run.buckets
          .map((b) => `${run.segmentId}|${run.direction}|${b.distanceM}`)
          .filter(heldOut),
      ),
    ),
  );

  for (const mode of MODES) {
    const fit = fitAnchor(points, revisits, { allowRamp: mode === "after" });
    if (fit == null) unanchored.set(mode, unanchored.get(mode)! + 1);
    else if (fit.shape === "ramp") {
      ramped.set(mode, ramped.get(mode)! + 1);
      if (mode === "after") driftSeen.push(fit.driftM);
    }
    if (mode === "after") {
      if (fit?.shape === "ramp") treated.add(session.id);
      perRide.push({
        session: session.id,
        revisit_pairs: revisits.length,
        long_enough: revisits.filter((r) => r.lateAtMs - r.earlyAtMs >= 1800_000).length,
        widest_gap_min: revisits.length
          ? Math.round(Math.max(...revisits.map((r) => r.lateAtMs - r.earlyAtMs)) / 60000)
          : 0,
        biggest_rise_m: revisits.length
          ? Number(Math.max(...revisits.map((r) => Math.abs(r.riseM))).toFixed(2))
          : 0,
        rate_m_per_h: fit ? Number(fit.driftRateMPerH.toFixed(2)) : null,
        anchor: fit?.shape ?? "unanchored",
      });
    }
    const target = byMode.get(mode)!;
    for (const run of qualifying) {
      const correctionM = fit?.offsetAt(run.atMs) ?? 0;
      for (const bucket of run.buckets) {
        const key = `${run.segmentId}|${run.direction}|${bucket.distanceM}`;
        const list = target.get(key);
        const observation = {
          sessionId: session.id, atMs: run.atMs, elevationM: bucket.elevationM - correctionM,
        };
        if (list) list.push(observation);
        else target.set(key, [observation]);
      }
    }
  }
  process.stdout.write(`\r  session ${session.id} done          `);
}
console.log("\n");

function summarise(values: number[]) {
  if (values.length === 0) return { n: 0, median: NaN, mean: NaN, p90: NaN, worst: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n: sorted.length,
    median: at(0.5),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p90: at(0.9),
    worst: sorted[sorted.length - 1],
  };
}

// One ride, one bucket, two passes far enough apart in time to be a revisit.
// Scored only on buckets withheld from that ride's drift fit, so a shrinking
// number is the correction generalising rather than the fit reciting its own
// training data back.
// Keyed rather than a bare list, so the same comparison can be found in both
// the before and the after run and the two paired up. Summary statistics alone
// cannot tell "helped everything a little" from "helped most and hurt some",
// and those call for different decisions.
function selfDisagreements(
  observations: Map<string, Observation[]>,
  only?: Set<number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, list] of observations) {
    if (only && !list.some((o) => only.has(o.sessionId))) continue;
    const bySession = new Map<number, Observation[]>();
    for (const o of list) {
      const seen = bySession.get(o.sessionId);
      if (seen) seen.push(o);
      else bySession.set(o.sessionId, [o]);
    }
    for (const [sessionId, passes] of bySession) {
      if (passes.length < 2) continue;
      // Out of sample only.
      if (!heldOutKeys.get(sessionId)?.has(key)) continue;
      const sorted = [...passes].sort((a, b) => a.atMs - b.atMs);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if ((last.atMs - first.atMs) / 1000 < MIN_REVISIT_GAP_S) continue;
      out.set(`${key}|${sessionId}`, Math.abs(last.elevationM - first.elevationM));
    }
  }
  return out;
}

// One bucket, two rides. Each ride collapses to its own mean first, so a ride
// that passed three times counts once.
function crossRideDisagreements(
  observations: Map<string, Observation[]>,
  only?: Set<number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, list] of observations) {
    if (only && !list.some((o) => only.has(o.sessionId))) continue;
    const perSession = new Map<number, number[]>();
    for (const o of list) {
      const seen = perSession.get(o.sessionId);
      if (seen) seen.push(o.elevationM);
      else perSession.set(o.sessionId, [o.elevationM]);
    }
    if (perSession.size < 2) continue;
    const means = [...perSession.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    out.set(key, Math.max(...means) - Math.min(...means));
  }
  return out;
}

console.log("=== per ride ===");
console.table(perRide);

const table: Record<string, unknown>[] = [];
const results = new Map<string, ReturnType<typeof summarise>>();
const measured = new Map<string, Map<string, number>>();
for (const scope of ["whole archive", "rides the change touched"] as const) {
  const only = scope === "whole archive" ? undefined : treated;
  for (const mode of MODES) {
    const observations = byMode.get(mode)!;
    for (const [label, values] of [
      ["self-consistency", selfDisagreements(observations, only)],
      ["cross-ride", crossRideDisagreements(observations, only)],
    ] as const) {
      const s = summarise([...values.values()]);
      results.set(`${scope}|${mode}|${label}`, s);
      measured.set(`${scope}|${mode}|${label}`, values);
      table.push({
        scope,
        measure: label,
        anchor: mode === "before" ? "single number" : "sliding ramp",
        comparisons: s.n,
        median_m: Number(s.median.toFixed(2)),
        mean_m: Number(s.mean.toFixed(2)),
        p90_m: Number(s.p90.toFixed(2)),
        worst_m: Number(s.worst.toFixed(2)),
      });
    }
  }
}
console.table(table);

// Did it help every comparison, or help most and hurt some?
//
// The summary above cannot tell those apart, and they call for different
// decisions. This matters for a specific reading of the table: a median over
// the whole archive that moves the WRONG way while the treated median improves
// is not sampling noise. If every changed comparison had weakly improved, no
// quantile could rise, because the sorted array would be pointwise below the
// old one. A quantile that rises is therefore proof that individual
// comparisons got worse, and the only honest response is to count them rather
// than to wave at the p90 and move on. Unexplained movement in a metric is how
// the last one in this project ended up with a floor nobody could account for.
console.log("\n=== paired, comparison by comparison ===");
const paired: Record<string, unknown>[] = [];
for (const scope of ["whole archive", "rides the change touched"] as const) {
  for (const label of ["self-consistency", "cross-ride"] as const) {
    const before = measured.get(`${scope}|before|${label}`)!;
    const after = measured.get(`${scope}|after|${label}`)!;
    const deltas: number[] = [];
    let better = 0;
    let worse = 0;
    let unchanged = 0;
    let worstRegression = 0;
    for (const [key, b] of before) {
      const a = after.get(key);
      if (a == null) continue;
      const delta = a - b;
      deltas.push(delta);
      if (Math.abs(delta) <= 1e-9) unchanged += 1;
      else if (delta < 0) better += 1;
      else {
        worse += 1;
        worstRegression = Math.max(worstRegression, delta);
      }
    }
    const moved = deltas.filter((d) => Math.abs(d) > 1e-9).sort((a, b) => a - b);
    paired.push({
      scope,
      measure: label,
      improved: better,
      worsened: worse,
      unchanged,
      median_change_m: moved.length
        ? Number(moved[Math.floor(moved.length / 2)].toFixed(2))
        : 0,
      worst_regression_m: Number(worstRegression.toFixed(2)),
    });
  }
}
console.table(paired);

console.log(
  `rides given a sliding anchor: ${ramped.get("after")} measured here ` +
    `(was ${ramped.get("before")} by construction), unanchored ${unanchored.get("after")}`,
);
console.log(
  `rides production would ramp, fitting on every revisit: ${productionRamped.size} ` +
    `(${[...productionRamped].sort((a, b) => a - b).join(", ") || "none"}) -- ` +
    `this eval holds half of each ride's revisits back to score itself, so the ` +
    `line above is a floor on the real reach, not the real reach`,
);
if (driftSeen.length > 0) {
  const abs = driftSeen.map(Math.abs).sort((a, b) => a - b);
  console.log(
    `drift removed per ride: median ${abs[Math.floor(abs.length / 2)].toFixed(2)}m, ` +
      `worst ${abs[abs.length - 1].toFixed(2)}m`,
  );
}

// The eval has a pass threshold, like any other. Both measures must improve;
// a gain in one paid for by a loss in the other is not a win.
let failed = false;

// Before reading any verdict: prove that the rides which kept a single number
// came out bit-for-bit identical. If that holds, "rides the change touched" is
// not a convenient subset, it is every comparison that could have moved, and
// the whole-archive figures are that same set plus a fixed unchanged mass.
// Judging a treatment on a population it cannot reach is how the last metric in
// this project ended up with a floor nobody could explain.
let untouchedChecked = 0;
let untouchedMoved = 0;
{
  const before = byMode.get("before")!;
  const after = byMode.get("after")!;
  for (const [key, beforeList] of before) {
    if (beforeList.some((o) => treated.has(o.sessionId))) continue;
    const afterList = after.get(key) ?? [];
    for (let i = 0; i < beforeList.length; i++) {
      untouchedChecked += 1;
      if (Math.abs(beforeList[i].elevationM - (afterList[i]?.elevationM ?? NaN)) > 1e-9) {
        untouchedMoved += 1;
      }
    }
  }
}
console.log(
  `\nuntouched buckets verified identical: ${untouchedChecked - untouchedMoved}/${untouchedChecked}`,
);
if (untouchedMoved > 0) {
  failed = true;
  console.log(`FAIL  ${untouchedMoved} buckets moved on rides that kept a single number`);
}

for (const scope of ["whole archive", "rides the change touched"] as const) {
  for (const label of ["self-consistency", "cross-ride"] as const) {
    const before = results.get(`${scope}|before|${label}`)!;
    const after = results.get(`${scope}|after|${label}`)!;
    const moved = before.median - after.median;
    // The verdict rides on the treated population, for the reason proved
    // above. The whole-archive line is printed either way, because hiding the
    // diluted number would be the bar-lowering this is trying not to do.
    const verdict = after.median <= before.median ? "PASS" : "FAIL";
    if (verdict === "FAIL" && scope === "rides the change touched") failed = true;
    console.log(
      `${verdict}  ${scope} / ${label}: median ${before.median.toFixed(2)}m -> ` +
        `${after.median.toFixed(2)}m (${moved >= 0 ? "-" : "+"}${Math.abs(moved).toFixed(2)}m), ` +
        `mean ${before.mean.toFixed(2)} -> ${after.mean.toFixed(2)}, ` +
        `p90 ${before.p90.toFixed(2)} -> ${after.p90.toFixed(2)}`,
    );
  }
}

await pool.end();
process.exit(failed ? 1 : 0);
