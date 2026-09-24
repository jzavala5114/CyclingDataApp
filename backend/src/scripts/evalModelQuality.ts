import "dotenv/config";
import { pool } from "../db/pool.js";
import { matchSamplesToSegments, stitchFragmentedRuns } from "../services/segmentMatcher.js";
import { assessRun } from "../services/elevationAggregator.js";
import { rejectElevationSpikes, smoothElevations } from "../services/elevationSmoothing.js";
import { demKey } from "../services/demElevation.js";
import { fitAnchor } from "../services/anchorFit.js";
import { isUsable, loadSessionVerdicts } from "../services/usableSessions.js";
import {
  MEASURES,
  measure,
  summarise,
  type Observation,
  type Observations,
} from "../services/evalMeasures.js";
import type { Segment, SessionSample } from "../types/index.js";

// How good is the elevation model right now?
//
//   npx tsx src/scripts/evalModelQuality.ts
//
// Three numbers, all at bucket level because buckets are what the map draws:
//
//   Self-consistency  one ride, one bucket, two passes at least five minutes
//                     apart. The rider cannot have changed the height of the
//                     ground between them, so any difference is the ride
//                     disagreeing with itself. Needs no second ride and no
//                     terrain model, which makes it the closest thing to a
//                     ground truth here.
//
//   Cross-ride        one bucket, every pass from two or more rides, measured
//                     as the spread about their mean -- which is the value
//                     `mergeBuckets` actually draws.
//
//   Terrain shape     one ride against the USGS 3DEP model, with the ride's own
//                     median residual removed so only the SHAPE is scored. The
//                     only one of the three that consults anything outside our
//                     own archive.
//
// **This replaces `evalAnchorDrift.ts`, and it answers a different question.**
// That script was a before/after comparison built to judge the sliding drift
// anchor, with gates and a pass/fail verdict. The anchor was removed after four
// reviews (see `anchorFit.ts`), and with no second mode to compare against,
// every gate, the pairing and the untouched-bucket proof went with it. What is
// left is a report, not a gate: it prints where the model stands so two runs
// either side of a change can be compared by eye.
//
// The obvious use is a rebuild. `rebuildModel.ts` recomputes every stored
// bucket, and without a measurement "did that help?" has no answer beyond row
// counts. Run this before, run it after, compare.
//
// Reads only. Writes nothing, and fetches no terrain: it uses the DEM values
// already cached in `segment_dem_elevations`. That makes its terrain coverage
// strictly poorer than a rebuild's, which calls `ensureDemElevations` and
// fetches what is missing -- so the terrain-shape comparison count here is a
// floor, not the full picture.

const BBOX_PAD_DEG = 0.005;

const observations: Observations = new Map();
let unanchored = 0;
const offsets: number[] = [];

const verdicts = await loadSessionVerdicts(pool);
const usable = verdicts.filter(isUsable);
console.log(`measuring ${usable.length} usable sessions\n`);

for (const session of usable) {
  const { rows: samples } = await pool.query<SessionSample>(
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
    segmentId: number;
    direction: "forward" | "backward";
    atMs: number;
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

  // The same anchor production applies, so what is measured below is the model
  // as it would be stored, not the raw readings.
  const residualsM: number[] = [];
  for (const run of qualifying) {
    for (const bucket of run.buckets) {
      const reference = dem.get(
        demKey({ segmentId: run.segmentId, direction: run.direction, distanceM: bucket.distanceM }),
      );
      if (reference == null) continue;
      residualsM.push(bucket.elevationM - reference);
    }
  }
  const anchorM = fitAnchor(residualsM);
  if (anchorM == null) unanchored += 1;
  else offsets.push(anchorM);

  for (const run of qualifying) {
    for (const bucket of run.buckets) {
      // One key, from `demKey`, for both the DEM lookup and the bucket
      // identity. These were built two ways three lines apart -- hand-rolled
      // here and via `demKey` there -- which produce the same string today and
      // would silently diverge the day `demKey` changes.
      const key = demKey({
        segmentId: run.segmentId,
        direction: run.direction,
        distanceM: bucket.distanceM,
      });
      const observation: Observation = {
        sessionId: session.id,
        atMs: run.atMs,
        // Production's own anchor, or nothing when it refused one. What is
        // measured below is therefore the model as it would be stored,
        // including a ride the anchor rejected -- see `terrainDisagreements`.
        elevationM: bucket.elevationM - (anchorM ?? 0),
        demM: dem.get(key) ?? null,
      };
      const list = observations.get(key);
      if (list) list.push(observation);
      else observations.set(key, [observation]);
    }
  }
  process.stdout.write(`\r  session ${session.id} done          `);
}
console.log("\n");

const table = MEASURES.map((name) => {
  const s = summarise([...measure(name, observations).values()]);
  return {
    measure: name,
    comparisons: s.n,
    non_finite: s.nonFinite,
    median_m: Number(s.median.toFixed(2)),
    mean_m: Number(s.mean.toFixed(2)),
    p90_m: Number(s.p90.toFixed(2)),
    worst_m: Number(s.worst.toFixed(2)),
  };
});
console.table(table);

console.log(
  `anchored ${offsets.length} rides, ${unanchored} merged unanchored` +
    (offsets.length > 0
      ? `. Offsets: median ${[...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)].toFixed(2)}m, ` +
        `range ${Math.min(...offsets).toFixed(2)} to ${Math.max(...offsets).toFixed(2)}m`
      : ""),
);

// **A report, not a gate, and no PASS line is printed anywhere.** There is no
// second mode to compare against, so nothing here could honestly pass or fail;
// claiming otherwise would be the same "a check that cannot fail, reported as a
// check that passed" the reviews of this project keep finding.
//
// Exit 1 covers two different broken states, both of which mean the numbers
// above should not be read:
//
//   empty  a measure had nothing to compare -- an empty archive, or a cold DEM
//          cache. The RUN is broken.
//   dirty  a measure met a value that is not a number. `elevation_m` is
//          `double precision` in both `session_samples` and
//          `segment_dem_elevations`, and Postgres admits NaN there, so this is
//          the MODEL being broken, not the run.
//
// Two causes, one exit code, because the response to either is the same: stop
// and look. The distinction is in the printed line.
const empty = table.filter((row) => row.comparisons === 0);
const dirty = table.filter((row) => row.non_finite > 0);
for (const row of empty) console.log(`NO DATA  ${row.measure}: nothing to measure`);
for (const row of dirty) {
  console.log(`BROKEN   ${row.measure}: ${row.non_finite} non-finite value(s) in the model`);
}

await pool.end();
process.exit(empty.length > 0 || dirty.length > 0 ? 1 : 0);
