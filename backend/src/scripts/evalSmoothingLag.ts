import "dotenv/config";
import { pool } from "../db/pool.js";
import { matchSamplesToSegments, stitchFragmentedRuns } from "../services/segmentMatcher.js";
import { assessRun } from "../services/elevationAggregator.js";
import { rejectElevationSpikes } from "../services/elevationSmoothing.js";
import { demKey } from "../services/demElevation.js";
import { isUsable, loadSessionVerdicts } from "../services/usableSessions.js";
import type { Direction, Segment, SessionSample } from "../types/index.js";

// Does removing the smoothing lag make the model more accurate?
//
//   npx tsx src/scripts/evalSmoothingLag.ts
//
// The gate tests prove the new filter has no lag on synthetic input. This asks
// whether that matters on the real archive, against a reference the filter
// cannot influence.
//
// **The reference is the terrain model.** That is the point. A lag does not
// change a ride's heights, it MOVES them along the road -- so it cannot be
// caught by asking whether a ride agrees with itself, which is the trap the
// drift-anchor eval fell into. It shows up as a shape mismatch against ground
// whose shape is known independently.
//
// Two measures, both computed per ride after removing that ride's median
// residual, because the absolute level is what the DEM anchor exists to fix and
// is not what is under test here:
//
//   shape error   spread of (ride - DEM) within one ride. A profile slid along
//                 the road fits undulating terrain worse than one that is not.
//
//   cross-ride    two rides, one bucket. The lag is speed-dependent, so two
//                 rides taken at different speeds disagree by more than their
//                 noise. This is what reaches the map.
//
// Reads only. Fetches no terrain: it uses what is already cached in
// segment_dem_elevations, so a ride whose terrain was never fetched simply
// contributes fewer points, exactly as in a rebuild.

const BBOX_PAD_DEG = 0.005;

// The filter this replaces, kept here so the comparison runs through real code
// rather than a description of it. Causal EMA, alpha 0.3, no padding.
function smoothCausal(samples: SessionSample[]): SessionSample[] {
  let ema: number | null = null;
  return samples.map((sample) => {
    ema = ema == null ? sample.elevationM : 0.3 * sample.elevationM + 0.7 * ema;
    return { ...sample, elevationM: ema };
  });
}

type Mode = "causal" | "zero-phase";
const MODES: Mode[] = ["causal", "zero-phase"];

const { smoothElevations } = await import("../services/elevationSmoothing.js");
const smootherFor: Record<Mode, (s: SessionSample[]) => SessionSample[]> = {
  causal: smoothCausal,
  "zero-phase": smoothElevations,
};

interface Observation {
  sessionId: number;
  elevationM: number;
  speedMps: number | null;
}

const byMode = new Map<Mode, Map<string, Observation[]>>(MODES.map((m) => [m, new Map()]));
const shapeErrors = new Map<Mode, number[]>(MODES.map((m) => [m, []]));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

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

  // Spike rejection first, exactly as processSession does, and identically for
  // both modes -- it does not depend on the smoother, so any difference below
  // is the smoother alone.
  const { kept } = rejectElevationSpikes(samples);
  const segmentsById = new Map(segmentRows.map((s) => [s.id, s]));

  for (const mode of MODES) {
    const smoothed = smootherFor[mode](kept);
    const orderById = new Map(smoothed.map((s, i) => [s.id, i]));
    const speedById = new Map(kept.map((s) => [s.id, s.speedMps]));

    const qualifying: Array<{
      segmentId: number; direction: Direction; speedMps: number | null;
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
      const speeds = run.samples
        .map((s) => speedById.get(s.id))
        .filter((v): v is number => v != null);
      qualifying.push({
        segmentId: segment.id,
        direction: run.direction,
        speedMps: speeds.length ? median(speeds) : null,
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

    const residuals: number[] = [];
    for (const run of qualifying) {
      for (const bucket of run.buckets) {
        const reference = dem.get(
          demKey({ segmentId: run.segmentId, direction: run.direction as never, distanceM: bucket.distanceM }),
        );
        if (reference == null) continue;
        residuals.push(bucket.elevationM - reference);
      }
    }
    // Shape, not level: take out the ride's own median before measuring spread,
    // since the level is precisely what the DEM anchor is for.
    if (residuals.length >= 10) {
      const centre = median(residuals);
      shapeErrors.get(mode)!.push(median(residuals.map((r) => Math.abs(r - centre))));
    }

    const target = byMode.get(mode)!;
    for (const run of qualifying) {
      for (const bucket of run.buckets) {
        const key = `${run.segmentId}|${run.direction}|${bucket.distanceM}`;
        const observation = {
          sessionId: session.id, elevationM: bucket.elevationM, speedMps: run.speedMps,
        };
        const list = target.get(key);
        if (list) list.push(observation);
        else target.set(key, [observation]);
      }
    }
  }
  process.stdout.write(`\r  session ${session.id} done          `);
}
console.log("\n");

function summarise(values: number[]) {
  if (values.length === 0) return { n: 0, median: NaN, mean: NaN, p90: NaN };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return {
    n: s.length,
    median: at(0.5),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p90: at(0.9),
  };
}

// Two rides over one bucket, keyed so the before/after runs can be paired.
// `speedGapMps` is how differently the two rides crossed it -- the lag error is
// proportional to that, so it is the axis the effect should appear along.
function crossRide(observations: Map<string, Observation[]>) {
  const out = new Map<string, { disagreementM: number; speedGapMps: number | null }>();
  for (const [key, list] of observations) {
    const perSession = new Map<number, { heights: number[]; speeds: number[] }>();
    for (const o of list) {
      const seen = perSession.get(o.sessionId) ?? { heights: [], speeds: [] };
      seen.heights.push(o.elevationM);
      if (o.speedMps != null) seen.speeds.push(o.speedMps);
      perSession.set(o.sessionId, seen);
    }
    if (perSession.size < 2) continue;
    const rides = [...perSession.values()].map((v) => ({
      height: v.heights.reduce((a, b) => a + b, 0) / v.heights.length,
      speed: v.speeds.length ? median(v.speeds) : null,
    }));
    const heights = rides.map((r) => r.height);
    const speeds = rides.map((r) => r.speed).filter((s): s is number => s != null);
    out.set(key, {
      disagreementM: Math.max(...heights) - Math.min(...heights),
      speedGapMps: speeds.length >= 2 ? Math.max(...speeds) - Math.min(...speeds) : null,
    });
  }
  return out;
}

// THE DECISIVE ONE. Two passes over the same 15m cell WITHIN ONE RIDE.
//
// Everything else cancels here by construction: same ride, so no barometric
// level difference and no drift between rides; same cell and direction, so
// identical ground; same anchor, so no correction to confound. What is left is
// the instrument and the filter. If the lag is real, the disagreement between
// two passes grows with how differently they were ridden -- and removing the
// lag should flatten that relationship.
//
// This is the measure the other two could not give: cross-ride disagreement is
// swamped by per-ride level offsets an order of magnitude larger, and shape
// error against the terrain model punishes genuine detail the model lacks.
function withinRide(observations: Map<string, Observation[]>) {
  const out = new Map<string, { disagreementM: number; speedGapMps: number }>();
  for (const [key, list] of observations) {
    const bySession = new Map<number, Observation[]>();
    for (const o of list) {
      const seen = bySession.get(o.sessionId);
      if (seen) seen.push(o);
      else bySession.set(o.sessionId, [o]);
    }
    for (const [sessionId, passes] of bySession) {
      if (passes.length < 2) continue;
      const speeds = passes.map((p) => p.speedMps).filter((s): s is number => s != null);
      if (speeds.length < 2) continue;
      const heights = passes.map((p) => p.elevationM);
      out.set(`${key}|${sessionId}`, {
        disagreementM: Math.max(...heights) - Math.min(...heights),
        speedGapMps: Math.max(...speeds) - Math.min(...speeds),
      });
    }
  }
  return out;
}

const table: Record<string, unknown>[] = [];
for (const mode of MODES) {
  const shape = summarise(shapeErrors.get(mode)!);
  table.push({
    filter: mode,
    measure: "shape error vs terrain (per ride)",
    rides: shape.n,
    median_m: Number(shape.median.toFixed(3)),
    mean_m: Number(shape.mean.toFixed(3)),
    p90_m: Number(shape.p90.toFixed(3)),
  });
}
const cross = new Map(MODES.map((m) => [m, crossRide(byMode.get(m)!)]));
for (const mode of MODES) {
  const all = summarise([...cross.get(mode)!.values()].map((v) => v.disagreementM));
  table.push({
    filter: mode,
    measure: "cross-ride disagreement",
    rides: all.n,
    median_m: Number(all.median.toFixed(3)),
    mean_m: Number(all.mean.toFixed(3)),
    p90_m: Number(all.p90.toFixed(3)),
  });
}
console.table(table);

// The mechanism check. The lag error scales with the difference in speed
// between the two rides, so if this change is doing what it claims, the gain
// should be concentrated where that gap is widest. A uniform gain across all
// bands would mean something else moved and the story is wrong.
console.log("=== cross-ride disagreement by how differently the two rides rode ===");
const bands: Array<[string, number, number]> = [
  ["under 1 m/s", 0, 1],
  ["1-2 m/s", 1, 2],
  ["2-4 m/s", 2, 4],
  ["over 4 m/s", 4, Infinity],
];
const banded: Record<string, unknown>[] = [];
for (const [label, lo, hi] of bands) {
  const row: Record<string, unknown> = { speed_gap: label };
  let n = 0;
  for (const mode of MODES) {
    const values = [...cross.get(mode)!.values()]
      .filter((v) => v.speedGapMps != null && v.speedGapMps >= lo && v.speedGapMps < hi)
      .map((v) => v.disagreementM);
    const s = summarise(values);
    n = s.n;
    row[mode === "causal" ? "causal_median_m" : "zerophase_median_m"] = Number(s.median.toFixed(3));
  }
  row.buckets = n;
  banded.push(row);
}
console.table(banded);

// Pair each comparison with itself, since a summary median cannot tell
// "helped everything" from "helped most and hurt some".
const before = cross.get("causal")!;
const after = cross.get("zero-phase")!;
let better = 0;
let worse = 0;
let unchanged = 0;
const deltas: number[] = [];
for (const [key, b] of before) {
  const a = after.get(key);
  if (a == null) continue;
  const delta = a.disagreementM - b.disagreementM;
  deltas.push(delta);
  if (Math.abs(delta) <= 1e-9) unchanged += 1;
  else if (delta < 0) better += 1;
  else worse += 1;
}
const moved = deltas.filter((d) => Math.abs(d) > 1e-9).sort((a, b) => a - b);
console.log(
  `paired: ${better} improved, ${worse} worsened, ${unchanged} unchanged, ` +
    `median change ${moved.length ? moved[Math.floor(moved.length / 2)].toFixed(3) : "0"}m`,
);

let failed = false;
const verdict = (label: string, beforeV: number, afterV: number) => {
  const ok = afterV <= beforeV;
  if (!ok) failed = true;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}: ${beforeV.toFixed(3)}m -> ${afterV.toFixed(3)}m ` +
      `(${afterV <= beforeV ? "-" : "+"}${Math.abs(beforeV - afterV).toFixed(3)}m)`,
  );
};
// The isolated measure, and the one the verdict should rest on.
const within = new Map(MODES.map((m) => [m, withinRide(byMode.get(m)!)]));
console.log("=== same ride, same cell, two passes: disagreement by speed gap ===");
const withinTable: Record<string, unknown>[] = [];
for (const [label, lo, hi] of bands) {
  const row: Record<string, unknown> = { speed_gap: label };
  let n = 0;
  for (const mode of MODES) {
    const values = [...within.get(mode)!.values()]
      .filter((v) => v.speedGapMps >= lo && v.speedGapMps < hi)
      .map((v) => v.disagreementM);
    const s = summarise(values);
    n = s.n;
    row[mode === "causal" ? "causal_median_m" : "zerophase_median_m"] = Number(s.median.toFixed(3));
  }
  row.pairs = n;
  withinTable.push(row);
}
console.table(withinTable);

const withinBefore = within.get("causal")!;
const withinAfter = within.get("zero-phase")!;
let wBetter = 0;
let wWorse = 0;
const wDeltas: number[] = [];
for (const [key, b] of withinBefore) {
  const a = withinAfter.get(key);
  if (a == null) continue;
  const delta = a.disagreementM - b.disagreementM;
  wDeltas.push(delta);
  if (delta < -1e-9) wBetter += 1;
  else if (delta > 1e-9) wWorse += 1;
}
const wMoved = wDeltas.filter((d) => Math.abs(d) > 1e-9).sort((a, b) => a - b);
console.log(
  `paired within-ride: ${wBetter} improved, ${wWorse} worsened, ` +
    `median change ${wMoved.length ? wMoved[Math.floor(wMoved.length / 2)].toFixed(3) : "0"}m\n`,
);

verdict(
  "within-ride, same cell, two passes (the isolated measure)",
  summarise([...withinBefore.values()].map((v) => v.disagreementM)).median,
  summarise([...withinAfter.values()].map((v) => v.disagreementM)).median,
);
verdict(
  "shape error vs terrain, median over rides",
  summarise(shapeErrors.get("causal")!).median,
  summarise(shapeErrors.get("zero-phase")!).median,
);
verdict(
  "cross-ride disagreement, median",
  summarise([...before.values()].map((v) => v.disagreementM)).median,
  summarise([...after.values()].map((v) => v.disagreementM)).median,
);

await pool.end();
process.exit(failed ? 1 : 0);
