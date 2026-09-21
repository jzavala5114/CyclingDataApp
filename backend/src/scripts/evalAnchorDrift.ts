import "dotenv/config";
import { pool } from "../db/pool.js";
import { matchSamplesToSegments, stitchFragmentedRuns } from "../services/segmentMatcher.js";
import { assessRun } from "../services/elevationAggregator.js";
import { rejectElevationSpikes, smoothElevations } from "../services/elevationSmoothing.js";
import { demKey } from "../services/demElevation.js";
// **`MAX_PLAUSIBLE_OFFSET_M` and `MIN_POINTS_FOR_ANCHOR` are deliberately NOT
// imported.** They were, and referenced nowhere in code -- only in the prose
// below, which argues at length that importing them is exactly what makes the
// control track the treatment. A reader checking whether `previousAnchor` is
// independent reads the import list first and found the two names the comment
// says must not be there.
import { fitAnchor, type AnchorFit, type AnchorPoint } from "../services/anchorFit.js";
import {
  collectRevisits,
  runElevationSource,
  siteKeyFor,
  type RunElevationSource,
} from "../services/sessionProcessor.js";
import { isUsable, loadSessionVerdicts } from "../services/usableSessions.js";
import {
  MEASURES,
  judgeMeasure,
  measure,
  pairedChange,
  summarise,
  verifyUntouched,
  type HeldOutKeys,
  type Observation,
  type Observations,
  type PairedChange,
  type Summary,
} from "../services/evalMeasures.js";
import type { Direction, Segment, SessionSample } from "../types/index.js";

// Does the elevation model agree with itself?
//
//   npx tsx src/scripts/evalAnchorDrift.ts
//
// The eval behind the sliding anchor. Gate tests prove the fit does what it
// says on synthetic rides; this proves it helps on the real archive, which is
// the only place the failure was ever visible.
//
// Three questions, all asked at bucket level, because buckets are what the map
// draws. Asking them of raw session_samples measures the uncorrected data and
// would not move no matter what the anchor did -- the correction is applied on
// the way into a bucket, never back onto the sample rows.
//
// (This said "two questions" and listed two, for as long as there have been
// three. The verdict block carried the same stale count in its own words. A
// count that drifts out of step with the list beside it is worth fixing on
// sight: it is how a reader comes away believing the harness asks less than it
// does, or the reverse.)
//
//   Self-consistency  one ride, one bucket, two passes at least half an hour
//                     apart. The rider cannot have changed the height of the
//                     ground between them, so any difference is the ride
//                     disagreeing with itself. The closest thing to a ground
//                     truth here, because it needs no second ride and no
//                     terrain model. Half an hour because that is the gap the
//                     FIT believes; see MIN_REVISIT_GAP_S in evalMeasures.ts.
//
//   Cross-ride        one bucket, several passes from two or more rides. What
//                     actually lands on the map, since the running mean blends
//                     them and a neighbouring bucket fed by a different mix
//                     lands somewhere else.
//
//   Terrain shape     one ride against the terrain model, with the ride's own
//                     level removed. The only one with an external referent:
//                     the other two ask whether the archive agrees with itself,
//                     which a tilt can satisfy while walking away from the
//                     ground.
//
// The measures, the untouched-bucket proof and the verdict rule live in
// services/evalMeasures.ts, with their own gate tests. They used to be inline
// here, closing over a module-level `heldOutKeys` beneath a top-level `await`
// against the database, which made every one of them untestable -- and the
// fourth round of review found three "a check that cannot fail, reported as a
// check that passed" defects living in exactly that blind spot. This file now
// loads rides, fits anchors and prints; it decides nothing.
//
// Reads only. Writes nothing, and fetches no terrain: it uses the DEM values
// already cached in segment_dem_elevations.
//
// **That makes the eval's terrain coverage strictly poorer than production's,
// and the bias has a direction.** An earlier version of this comment said a
// ride whose terrain was never fetched "contributes fewer points, exactly as it
// would in a rebuild". It would not: a rebuild goes through `processSession`,
// which calls `ensureDemElevations`, and that function FETCHES the missing
// points. So rides that production would anchor and ramp, this eval refuses for
// want of the ten points `MIN_POINTS_FOR_ANCHOR` requires. `treated` is biased
// down, which makes the vacuous-proof and inconclusive paths more likely here
// than they are in production -- read a small `treated` as partly an artefact of
// this script, not only as the feature's reach.

const BBOX_PAD_DEG = 0.005;

type Mode = "before" | "after";
const MODES: Mode[] = ["before", "after"];

// The shipped behaviour, transcribed from `fitDemOffset` in
// services/sessionProcessor.ts on main: the median terrain residual for the
// whole ride, refused when there are too few points to fit or when the answer
// is too large to be weather.
//
// Deliberately a second implementation rather than a call into anchorFit.ts.
// The eval's job here is to prove the new fitter reproduces the old one on every
// ride it does not treat, and a "before" that calls the new fitter cannot
// establish that -- it is the thing being tested. Duplicating thirty characters
// of median is the price of a control that is actually independent.
//
// Returns a full AnchorFit so the two are interchangeable at every use below.
// A constant correction has a well-defined value for each field: no drift, no
// rate, and the same offset at both ends and in the middle.
//
// Filtering non-finite points first, because main's fitDemOffset never had any
// to filter -- it built residuals from DEM lookups it had already null-checked.
// fitAnchor does the same filtering internally, so without it the two would
// disagree on a malformed ride for a reason that has nothing to do with ramps.
//
// **Its own literals, copied from main, NOT imported from anchorFit.ts.**
//
// The first version of this imported MIN_POINTS_FOR_ANCHOR and
// MAX_PLAUSIBLE_OFFSET_M from the module under test, which quietly undid the
// point of writing it: change either constant and the control changes with the
// treatment, so "identical to main's fitDemOffset" keeps printing while the
// shipped behaviour has in fact diverged from main. A control parameterised by
// the treatment is not a control.
//
// From main: MIN_DEM_POINTS_FOR_ANCHOR = 10, MAX_PLAUSIBLE_ANCHOR_OFFSET_M = 60
// in services/sessionProcessor.ts. If anchorFit.ts changes either, this must
// stay put and the identical-bucket check is then supposed to fail.
const MAIN_MIN_DEM_POINTS_FOR_ANCHOR = 10;
const MAIN_MAX_PLAUSIBLE_ANCHOR_OFFSET_M = 60;

function previousAnchor(points: AnchorPoint[]): AnchorFit | null {
  const clean = points.filter((p) => Number.isFinite(p.atMs) && Number.isFinite(p.residualM));
  if (clean.length < MAIN_MIN_DEM_POINTS_FOR_ANCHOR) return null;
  const residuals = clean.map((p) => p.residualM).sort((a, b) => a - b);
  const mid = Math.floor(residuals.length / 2);
  const offset =
    residuals.length % 2 === 0 ? (residuals[mid - 1] + residuals[mid]) / 2 : residuals[mid];
  if (!Number.isFinite(offset) || Math.abs(offset) > MAIN_MAX_PLAUSIBLE_ANCHOR_OFFSET_M) return null;
  return {
    offsetAt: () => offset,
    minM: offset,
    maxM: offset,
    driftM: 0,
    midM: offset,
    driftRateMPerH: 0,
    shape: "constant",
    points: clean.length,
    revisits: 0,
    revisitsUsed: 0,
  };
}

// mode -> "segment|direction|distance" -> observations from every ride
const byMode = new Map<Mode, Observations>(MODES.map((m) => [m, new Map()]));
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
// session -> the bucket keys withheld from that session's drift RATE fit.
//
// **Only the rate.** The heading this once carried, "hold half the ride's
// revisited ground out of the fit", overclaimed: `points` is built from every
// bucket of every qualifying run and both modes consume it unfiltered, so the
// LEVEL is fit on everything. What is withheld is the revisit set that
// `fitDriftRate` consumes. That does not bias before against after -- both fit
// the level the same way on the same points -- so the live question is the
// rate, and the rate is what this holds back.
const heldOutKeys: HeldOutKeys = new Map();

const verdicts = await loadSessionVerdicts(pool);
const usable = verdicts.filter(isUsable);
console.log(`measuring ${usable.length} sessions\n`);

for (const session of usable) {
  const { rows: samples } = await pool.query<SessionSample>(
    // elevation_source is selected because collectRevisits refuses to compare a
    // GPS-altitude pass against a barometric one. An eval that did not carry it
    // would measure a fitter with a guard production has and this does not.
    `select id, recorded_at as "recordedAt", lat, lon, elevation_m as "elevationM",
            elevation_source as "elevationSource",
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
    elevationSource: RunElevationSource;
    siteKey: string;
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
      // **Production's function, not a copy of it.** This re-derived the same
      // answer with a `Set` over `elevationSource`, under a comment saying it
      // "mirrors runElevationSource". The copy was correct, including the empty
      // run -- and that is not the point. The argument for duplicating
      // `previousAnchor` below inverts here: a duplicated CONTROL is deliberate
      // independence, a duplicated TREATMENT means the eval goes on measuring
      // correct behaviour after production's has diverged. This is the guard
      // that caught session 76 asking to tilt a real ride 20m, so it is the last
      // one that should be measured in effigy.
      //
      // (The neighbouring `siteKeyFor` call was always the real function, under
      // a comment that also said "mirrors". A reader could not tell which of the
      // two was wired to production. Now both are, and neither comment lies.)
      elevationSource: runElevationSource(run.samples),
      // The PLACE, not the segment. Segment rows split at every junction, so
      // counting them as sites lets one street form a quorum by itself.
      siteKey: siteKeyFor(segment),
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
  //
  // **What this split does NOT control for, stated because the comment above
  // overclaims on its own.** It is a split by BUCKET, and both halves come from
  // the same two passes of the same pair of runs. It controls for per-bucket
  // noise and nothing else. Every failure mode this fit actually has -- wrong
  // direction, mismatched instrument, speed-dependent lag, satellite geometry --
  // is a property of the run, and appears identically in both halves. Session 76
  // is the proof: its fabricated 20m tilt improved self-consistency on every
  // bucket of the ride, held out or not, and it took a fifth guard to catch
  // rather than this split. Treat a held-out gain as evidence against bucket
  // noise, not as evidence the correction generalises.
  //
  // The mixing below is a real hash, not the parity check it used to be. With
  // `h * 31` and 31 odd, the low bit of the accumulator is just the running sum
  // of the character codes mod 2, so testing `h & 1` reduced exactly to "is the
  // sum of the key's character codes odd" -- which put "1|forward|30" and
  // "1|forward|03" in the same half and made the split a function of a digit
  // sum. Multiplying by an even factor and reading a high bit avoids both.
  const heldOut = (key: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 16) & 1) === 1;
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
  if (fitAnchor(points, collectRevisits(qualifying), { allowRamp: true })?.shape === "ramp") {
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
    // `before` no longer goes through the code under test.
    //
    // It used to be `fitAnchor(..., { allowRamp: false })`, which meant that for
    // any ride the change did not treat, `before` and `after` were the same
    // `flat()` branch of the same function reached by two routes. The eval then
    // announced that every untouched bucket was bit-for-bit identical, and that
    // sentence was reported upwards as proof the change was safe. It proved
    // `flat() === flat()`. A control that shares an implementation with the
    // treatment is not a control.
    //
    // `previousAnchor` below is an independent transcription of `fitDemOffset`
    // as it stands on main, so "identical" now means the new fitter reproduces
    // the shipped behaviour, which is the claim actually being made.
    // `allowRamp` is explicit because it now defaults to OFF -- that default is
    // the shipped verdict, and this eval is the thing that re-measures it. An
    // eval that inherited the default would silently compare the single number
    // against itself, which is the tautology described above wearing new clothes.
    const fit =
      mode === "before" ? previousAnchor(points) : fitAnchor(points, revisits, { allowRamp: true });
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
        const observation: Observation = {
          sessionId: session.id, atMs: run.atMs, elevationM: bucket.elevationM - correctionM,
          demM: dem.get(
            demKey({
              segmentId: run.segmentId,
              direction: run.direction,
              distanceM: bucket.distanceM,
            }),
          ) ?? null,
        };
        if (list) list.push(observation);
        else target.set(key, [observation]);
      }
    }
  }
  process.stdout.write(`\r  session ${session.id} done          `);
}
console.log("\n");

console.log("=== per ride ===");
console.table(perRide);

const table: Record<string, unknown>[] = [];
const results = new Map<string, Summary>();
const measured = new Map<string, Map<string, number>>();
for (const scope of ["whole archive", "rides the change touched"] as const) {
  const only = scope === "whole archive" ? undefined : treated;
  for (const mode of MODES) {
    const observations = byMode.get(mode)!;
    for (const label of MEASURES) {
      const values = measure(label, observations, heldOutKeys, only);
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
// These numbers are no longer only printed. `judgeMeasure` gates `worsened`,
// the mean and the worst regression alongside the median -- see the four gates
// in evalMeasures.ts. Before that, every column below was computed, printed and
// ignored, and six comparisons improving 0.10m against five regressing 40m
// exited 0.
console.log("\n=== paired, comparison by comparison ===");
const changes = new Map<string, PairedChange>();
const paired: Record<string, unknown>[] = [];
for (const scope of ["whole archive", "rides the change touched"] as const) {
  for (const label of MEASURES) {
    const change = pairedChange(
      measured.get(`${scope}|before|${label}`)!,
      measured.get(`${scope}|after|${label}`)!,
    );
    changes.set(`${scope}|${label}`, change);
    paired.push({
      scope,
      measure: label,
      improved: change.improved,
      worsened: change.worsened,
      unchanged: change.unchanged,
      non_finite: change.nonFinite,
      median_change_m: Number(change.medianChangeM.toFixed(2)),
      mean_change_m: Number(change.meanChangeM.toFixed(2)),
      worst_regression_m: Number(change.worstRegressionM.toFixed(2)),
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

// The eval has a pass threshold, like any other. All three measures must hold
// on all four gates; a gain in one paid for by a loss in another is not a win.
//
// (This said "both measures" when there were three, and "improve" when the only
// thing consulted was the median. Both halves of that sentence were stale for
// as long as the gate was one line.)
let failed = false;

// **And an eval that measured nothing does not pass.**
//
// Every treated-scope measure printed NONE and `continue`d when the fit reached
// no ride, so `failed` was never set, and the script exited 0 while having
// certified precisely nothing. That is the worst possible reading to give: the
// one number that decides whether this feature is safe was reported as "fine"
// by a run that could not have detected any amount of harm.
//
// It is a third outcome rather than a FAIL, because it is a different finding.
// FAIL means the change made the archive worse. This means the change is not
// reachable by any ride here, so the archive cannot say. Both are non-zero;
// only a measured improvement exits 0.
//
//   0  measured, and every measure improved or held on every gate
//   1  measured, and something got worse
//   2  nothing was measured that could have moved, so there is no verdict
let inconclusive = false;
const inconclusiveBecause: string[] = [];

// Before reading any verdict: prove that the rides which kept a single number
// came out bit-for-bit identical. If that holds, "rides the change touched" is
// not a convenient subset, it is every comparison that could have moved, and
// the whole-archive figures are that same set plus a fixed unchanged mass.
// Judging a treatment on a population it cannot reach is how the last metric in
// this project ended up with a floor nobody could explain.
const untouched = verifyUntouched(byMode.get("before")!, byMode.get("after")!, treated);

// **The proof reports what it actually verified, and a vacuous run is not a
// pass.** This printed `verified identical: 0/0` and exited 0 whenever every
// bucket had a treated contributor, which is the same "check that cannot fail,
// reported as a check that passed" the feature has now been rejected for four
// times -- sitting inside the proof that licenses every other verdict here.
if (untouched.vacuous) {
  inconclusive = true;
  inconclusiveBecause.push(
    "the untouched-bucket proof had no subjects: every bucket has a treated " +
      "contributor, so it verified nothing and cannot license the treated scope",
  );
  console.log(
    `\nuntouched buckets: NONE to check -- every bucket has a treated contributor. ` +
      `The identical-bucket proof is vacuous on this run and certifies nothing.`,
  );
} else {
  console.log(
    `\nuntouched buckets verified identical: ${untouched.checked - untouched.moved}/${untouched.checked}` +
      ` (against an independent transcription of main's fitDemOffset)`,
  );
}
// The per-ride form of the same vacuity. A bucket with a treated contributor is
// skipped whole, so an untreated ride sharing every bucket with a treated one is
// never checked -- while another ride's private buckets keep the printed count
// affirmative. That ride is then also filtered out of the treated-scope measures
// and lives only in the whole-archive line, which is never gated. Three blind
// spots closing a loop around one ride.
if (untouched.uncheckedSessions.length > 0) {
  inconclusive = true;
  inconclusiveBecause.push(
    `the untouched-bucket proof never looked at session(s) ` +
      `${untouched.uncheckedSessions.join(", ")}: every bucket they have is shared with a ` +
      `treated ride, so nothing establishes that they came out identical`,
  );
  console.log(
    `NONE  untouched proof did not cover session(s) ${untouched.uncheckedSessions.join(", ")} ` +
      `-- all their buckets are shared with a treated ride`,
  );
}
if (untouched.moved > 0) {
  failed = true;
  console.log(`FAIL  ${untouched.moved} buckets moved on rides that kept a single number`);
  if (untouched.missing > 0) {
    console.log(`FAIL  ${untouched.missing} of those are missing from "after" entirely`);
  }
}
// Reported only when it fires. It cannot fire while the observation population
// is built before and independently of the fit, and a check that cannot fail
// must not print as a check that passed.
if (untouched.structurallyDifferent > 0) {
  failed = true;
  console.log(
    `FAIL  ${untouched.structurallyDifferent} observation identities differ between modes -- ` +
      `the two modes no longer measure the same population, so no comparison below is paired`,
  );
}

for (const scope of ["whole archive", "rides the change touched"] as const) {
  for (const label of MEASURES) {
    const before = results.get(`${scope}|before|${label}`)!;
    const after = results.get(`${scope}|after|${label}`)!;
    const moved = before.median - after.median;
    const { verdict, reasons } = judgeMeasure(
      label,
      before,
      after,
      changes.get(`${scope}|${label}`)!,
      scope === "whole archive" ? "whole archive" : "treated",
    );

    if (verdict === "NONE") {
      console.log(`NONE  ${scope} / ${label}: ${reasons[0]}`);
      // Nothing to judge is not a failure -- saying FAIL here would be a lie in
      // the direction that looks rigorous. An empty treated set used to print
      // "median NaNm -> NaNm (+NaNm)" and count as a regression, because
      // `NaN <= NaN` is false, which reads as "the change made things worse"
      // when the change reached no ride at all. Exiting 0 is the opposite lie,
      // in the direction that looks reassuring. It is neither.
      if (scope === "rides the change touched") {
        inconclusive = true;
        inconclusiveBecause.push(`${label}: ${reasons[0]}`);
      }
      continue;
    }

    // The verdict rides on the treated population, for the reason the proof
    // above establishes. The whole-archive line is printed either way, because
    // hiding the diluted number would be the bar-lowering this is trying not to
    // do.
    if (scope === "rides the change touched") {
      if (verdict === "FAIL") failed = true;
      if (verdict === "INCONCLUSIVE") {
        inconclusive = true;
        inconclusiveBecause.push(`${label}: ${reasons[0]}`);
      }
    }
    console.log(
      `${verdict}  ${scope} / ${label}: median ${before.median.toFixed(2)}m -> ` +
        `${after.median.toFixed(2)}m (${moved >= 0 ? "-" : "+"}${Math.abs(moved).toFixed(2)}m), ` +
        `mean ${before.mean.toFixed(2)} -> ${after.mean.toFixed(2)}, ` +
        `p90 ${before.p90.toFixed(2)} -> ${after.p90.toFixed(2)}`,
    );
    for (const reason of reasons) console.log(`      ${verdict === "FAIL" ? "why" : "note"}: ${reason}`);
  }
}

if (inconclusive) {
  console.log(
    `\nINCONCLUSIVE  the fit treated ${treated.size} of ${usable.length} usable rides. Exit 2 ` +
      `rather than 0: a run that could not have detected harm must not read as a pass.`,
  );
  for (const why of inconclusiveBecause) console.log(`              - ${why}`);
  console.log(
    `              Production would ramp ${productionRamped.size} of ${usable.length} ` +
      `(it fits on every revisit; this eval withholds half). And this script never ` +
      `fetches terrain, so it refuses rides production would anchor -- treat ` +
      `${treated.size} as a floor, not as the reach.`,
  );
}

await pool.end();
// 1 beats 2: if something measurable got worse, that is the headline, and an
// empty scope elsewhere does not soften it.
process.exit(failed ? 1 : inconclusive ? 2 : 0);
