import "dotenv/config";
import * as turf from "@turf/turf";
import { pool } from "../db/pool.js";
import {
  ENDPOINT_SNAP_M,
  matchSamplesToSegments,
  stitchFragmentedRuns,
} from "../services/segmentMatcher.js";
import { assessRun, BUCKET_SIZE_M, type BucketSample } from "../services/elevationAggregator.js";
import { rejectElevationSpikes, smoothElevations } from "../services/elevationSmoothing.js";
import { rejectImpossibleSpeeds } from "../services/positionSpikes.js";
import { demKey } from "../services/demElevation.js";
import { fitAnchor } from "../services/anchorFit.js";
import { collectAnchorResiduals } from "../services/sessionProcessor.js";
import { segmentsWithLines } from "../services/segmentsResponse.js";
import { colorForSlope } from "../services/gradientBuilder.js";
import type {
  Direction,
  ElevationBucket,
  PassBucket,
  Segment,
  SegmentCoverage,
  SessionSample,
} from "../types/index.js";

// Where does the map's colour come from MIXING passes that sit at different
// levels, and does fitting each pass's own slope get closer to the ground?
//
//   npm run eval:mixing
//
// The map colours each piece of a line by a least-squares slope over a window
// of buckets (`slopeAt` in gradientBuilder.ts), and each bucket is the running
// mean of every pass that covered it. Each ride is lined up with the terrain
// model by ONE offset (`fitAnchor`), and a barometer drifts during a ride, so
// two passes over the same ground can sit metres apart. Where they cover
// different stretches of a line, the mean changes membership from one bucket to
// the next and their level difference becomes a step that the fit reads as a
// climb. The Ridgeway trailhead lot drew +25% on ground the terrain model puts
// at 3 to 6% (context/session.md, "Found 2026-10-16").
//
// For every drawn piece this fits four slopes over the same window:
//
//   mean heights  the fit over the stored means: what the map draws today.
//                 Checked against the server's own colour at every stop.
//   each pass     the mean of each pass's OWN least-squares slope over the
//                 window, weighted by how many of the window's buckets it
//                 covers, from passes covering two or more; clamped after
//                 averaging. A pass's level cannot reach it. Passes covering
//                 the same buckets give exactly the mean-heights slope,
//                 because least squares is linear in the heights. This is
//                 what gradientBuilder.ts draws when every pass is on file.
//   pooled        the alternative that lost: one slope shared by every pass,
//                 with a level of its own for each (least squares with an
//                 intercept per pass), so passes count by how spread out their
//                 buckets are rather than by how many they have.
//   terrain       the same window fitted to segment_dem_elevations (USGS NED
//                 10 m). The only one of the four from outside our rides.
//
// How "each pass" was chosen over "pooled", 2026-10-16, through ride 89. The
// rule, written before the first run: pooled ships unless it is further from
// terrain than count-weighting on the pieces two or more passes cover. It was,
// by 0.01 points (2.26 against 2.25), a tie that the rule settled for the
// estimator the plan had named. On the whole judged map both were 2.01; where
// mixing moved the colour, pooled was 2.78 and count-weighting 2.87.
//
// THE JUDGE IS THE TERRAIN. Mean heights minus each pass IS the mixing, and
// once the map draws each pass's slope it is zero by construction, so it can
// never be the evidence that the change helped. The verdict asks whether each
// pass is closer to the terrain than mean heights, on the pieces where mixing
// moved the colour and on every piece two or more passes cover, where the two
// can differ at all.
//
// Each pass's heights come from replaying every ride in the model through
// processSession's own steps, read only: the speed filter, the spike filter,
// zero-phase smoothing, the matcher, stitching, the traversal gate and the
// terrain anchor. The replay is trusted only where it reproduces the stored
// model, so a window is judged only when every bucket in it reproduces: the
// same pass count, and the mean within 0.05 m. Buckets that do not reproduce
// are listed by ride. Through ride 89 all 6,114 did; the 55 the census missed
// were the speed filter it left out.
//
// The server's colours are checked twice. "Now" is the map as it is drawn,
// from the stored pass rows (segment_pass_buckets) wherever they account for
// every pass. "Preview" hands the server the replay's passes as if every ride
// were on file, which is the map after a rebuild, and checks every stop
// against this script's own each-pass slope: the draw path tested on the whole
// city before anything is written. Once the table holds rows, they are also
// compared with the replay, pass by pass.
//
// READ ONLY: plain SELECTs in one read-only transaction, rolled back. Fetches
// no terrain; it uses the cached values, as evalModelQuality.ts does.
//
// Exits 1 when this script's slope disagrees with the server's colour at any
// stop, now or in the preview, or when the verdict fails.

const BBOX_PAD_DEG = 0.005;
const HALF_BUCKET_M = BUCKET_SIZE_M / 2;
// gradientBuilder.ts's window and clamp, restated rather than imported so that
// the agreement check below compares two implementations, not one with itself.
const SLOPE_WINDOW = 2;
const MAX_PLAUSIBLE_SLOPE_PCT = 25;
const REPRODUCED_WITHIN_M = 0.05;
// A pass from a ride's first or last five minutes, when the barometer has had
// the least time to settle or the most time to drift.
const NEAR_RIDE_ENDS_MIN = 5;
// More than one colour band, the census's threshold for "mixing moved it".
const ONE_BAND_PCT = 3;
// The three lines through the Ridgeway trailhead lot, and Ladders, the
// near-black climb Julian confirmed as right.
const LOT_LINES = ["28973/backward", "28974/backward", "19410/backward"];
const CONTROL_LINE = "19475/forward";
const NEAR_BLACK_ABOVE_PCT = 12;

interface PassHeight {
  pass: string;
  sessionId: number;
  nearRideEnds: boolean;
  elevationM: number;
}

const bucketKey = (segmentId: number, direction: Direction, distanceM: number) =>
  demKey({ segmentId, direction, distanceM });
const lineKey = (segmentId: number, direction: Direction) => `${segmentId}/${direction}`;

// ---- replay ------------------------------------------------------------------

const passesAt = new Map<string, PassHeight[]>();
const replayedRunsBySessionLine = new Map<string, number>();
let segs: Segment[] = [];
let buckets: ElevationBucket[] = [];
let coverage: SegmentCoverage[] = [];
let storedMatches: Array<{ segmentId: number; direction: Direction; sessionId: number; runs: number }> = [];
const terrainAt = new Map<string, number>();
let sessionIds: number[] = [];
let passTableExists = false;
let storedPassRows: Array<PassBucket & { sessionId: number; firstSampleId: number }> = [];

const client = await pool.connect();
try {
  await client.query("begin transaction read only");
  ({ rows: storedMatches } = await client.query<{
    segmentId: number;
    direction: Direction;
    sessionId: number;
    runs: number;
  }>(
    `select segment_id as "segmentId", direction, session_id as "sessionId", count(*)::int as runs
       from session_segment_matches group by 1, 2, 3`,
  ));
  sessionIds = [...new Set(storedMatches.map((m) => m.sessionId))].sort((a, b) => a - b);

  for (const [n, sessionId] of sessionIds.entries()) {
    // The same two queries processSession makes.
    const { rows: sampleRows } = await client.query<SessionSample>(
      `select id, session_id as "sessionId", recorded_at as "recordedAt", lat, lon,
              elevation_m as "elevationM", elevation_source as "elevationSource",
              altitude_accuracy_m as "altitudeAccuracyM", heading_deg as "headingDeg",
              speed_mps as "speedMps", accuracy_m as "accuracyM"
         from session_samples where session_id = $1 order by recorded_at`,
      [sessionId],
    );
    if (sampleRows.length === 0) continue;
    const lats = sampleRows.map((s) => s.lat);
    const lons = sampleRows.map((s) => s.lon);
    const { rows: segmentRows } = await client.query<Segment>(
      `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
              start_node_id as "startNodeId", end_node_id as "endNodeId",
              piece_index as "pieceIndex",
              ST_AsGeoJSON(geom)::json as geom, length_m as "lengthM", bearing_deg as "bearingDeg"
         from segments
        where geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          and canonical_segment_id is null`,
      [
        Math.min(...lons) - BBOX_PAD_DEG,
        Math.min(...lats) - BBOX_PAD_DEG,
        Math.max(...lons) + BBOX_PAD_DEG,
        Math.max(...lats) + BBOX_PAD_DEG,
      ],
    );

    // processSession's order: impossible positions, then impossible heights,
    // then smoothing.
    const { kept: reachable } = rejectImpossibleSpeeds(sampleRows);
    const { kept } = rejectElevationSpikes(reachable);
    const smoothed = smoothElevations(kept);
    const runs = stitchFragmentedRuns(
      matchSamplesToSegments(smoothed, segmentRows, { endpointSnapM: ENDPOINT_SNAP_M }),
    );
    const segmentsById = new Map(segmentRows.map((s) => [s.id, s]));
    const orderById = new Map(smoothed.map((s, i) => [s.id, i]));
    const rideStartMs = Date.parse(sampleRows[0]!.recordedAt);
    const rideEndMs = Date.parse(sampleRows[sampleRows.length - 1]!.recordedAt);

    const qualifying = [];
    for (const run of runs) {
      const segment = segmentsById.get(run.segmentId);
      if (!segment) continue;
      const firstIndex = orderById.get(run.samples[0]!.id) ?? 0;
      const lastIndex = orderById.get(run.samples[run.samples.length - 1]!.id) ?? 0;
      const { qualified, profile } = assessRun(run, segment, {
        before: firstIndex > 0 ? smoothed[firstIndex - 1] : undefined,
        after: lastIndex < smoothed.length - 1 ? smoothed[lastIndex + 1] : undefined,
      });
      if (!qualified) continue;
      const startMs = Date.parse(run.samples[0]!.recordedAt);
      const endMs = Date.parse(run.samples[run.samples.length - 1]!.recordedAt);
      qualifying.push({
        segment,
        direction: run.direction,
        buckets: profile.buckets,
        coveredFromM: profile.coveredFromM,
        coveredToM: profile.coveredToM,
        firstSampleId: run.samples[0]!.id,
        lastSampleId: run.samples[run.samples.length - 1]!.id,
        nearRideEnds:
          ((startMs + endMs) / 2 - rideStartMs) / 60000 < NEAR_RIDE_ENDS_MIN ||
          (rideEndMs - endMs) / 60000 < NEAR_RIDE_ENDS_MIN,
        // Named as its stored match row names it: by ride and first sample.
        pass: `${sessionId}|${run.samples[0]!.id}`,
      });
    }

    const { rows: demRows } = await client.query<{
      segmentId: number;
      direction: Direction;
      distanceM: number;
      elevationM: number;
    }>(
      `select segment_id as "segmentId", direction, distance_m as "distanceM", elevation_m as "elevationM"
         from segment_dem_elevations where segment_id = any($1)`,
      [qualifying.map((r) => r.segment.id)],
    );
    const dem = new Map(demRows.map((r) => [bucketKey(r.segmentId, r.direction, r.distanceM), r.elevationM]));
    // processSession's own residual loop and anchor, called rather than copied.
    const anchorM = fitAnchor(collectAnchorResiduals(qualifying, dem));

    for (const run of qualifying) {
      const heights: BucketSample[] =
        anchorM == null
          ? run.buckets
          : run.buckets.map((b) => ({ ...b, elevationM: b.elevationM - anchorM }));
      for (const b of heights) {
        const key = bucketKey(run.segment.id, run.direction, b.distanceM);
        const list = passesAt.get(key) ?? [];
        list.push({ pass: run.pass, sessionId, nearRideEnds: run.nearRideEnds, elevationM: b.elevationM });
        passesAt.set(key, list);
      }
      const k = `${sessionId}|${lineKey(run.segment.id, run.direction)}`;
      replayedRunsBySessionLine.set(k, (replayedRunsBySessionLine.get(k) ?? 0) + 1);
    }
    process.stderr.write(`\r  replayed ${n + 1}/${sessionIds.length} rides   `);
  }
  process.stderr.write("\n");

  // What GET /segments reads, for every drawn segment in the city.
  ({ rows: segs } = await client.query<Segment>(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            piece_index as "pieceIndex",
            ST_AsGeoJSON(geom)::json as geom, length_m as "lengthM", bearing_deg as "bearingDeg"
       from segments s
      where s.canonical_segment_id is null
        and exists (select 1 from segment_elevation_buckets b where b.segment_id = s.id)`,
  ));
  const ids = segs.map((s) => s.id);
  ({ rows: buckets } = await client.query<ElevationBucket>(
    `select segment_id as "segmentId", direction, distance_m as "distanceM",
            elevation_m as "elevationM", sample_count as "sampleCount"
       from segment_elevation_buckets where segment_id = any($1)`,
    [ids],
  ));
  ({ rows: coverage } = await client.query<SegmentCoverage>(
    `select segment_id as "segmentId", direction,
            covered_from_m as "coveredFromM", covered_to_m as "coveredToM"
       from segment_coverage where segment_id = any($1)`,
    [ids],
  ));
  const { rows: terrainRows } = await client.query<{
    segmentId: number;
    direction: Direction;
    distanceM: number;
    elevationM: number;
  }>(
    `select segment_id as "segmentId", direction, distance_m as "distanceM", elevation_m as "elevationM"
       from segment_dem_elevations where segment_id = any($1)`,
    [ids],
  );
  for (const r of terrainRows) terrainAt.set(bucketKey(r.segmentId, r.direction, r.distanceM), r.elevationM);
  // The pass rows, once the table exists: what GET /segments reads, plus each
  // row's ride and first sample, which name the pass the replay made.
  const { rows: table } = await client.query<{ present: boolean }>(
    "select to_regclass('segment_pass_buckets') is not null as present",
  );
  passTableExists = table[0]!.present;
  if (passTableExists) {
    ({ rows: storedPassRows } = await client.query<PassBucket & { sessionId: number; firstSampleId: number }>(
      `select m.segment_id as "segmentId", m.direction, p.match_id as "matchId",
              p.distance_m as "distanceM", p.elevation_m as "elevationM",
              m.session_id as "sessionId", m.first_sample_id as "firstSampleId"
         from segment_pass_buckets p
         join session_segment_matches m on m.id = p.match_id`,
    ));
  }
  await client.query("rollback");
} finally {
  client.release();
  await pool.end();
}

// ---- does the replay reproduce the stored model? ------------------------------

const reproduced = new Set<string>();
const notReproducedLines = new Set<string>();
for (const b of buckets) {
  const key = bucketKey(b.segmentId, b.direction, b.distanceM);
  const heights = passesAt.get(key) ?? [];
  const mean = heights.reduce((t, h) => t + h.elevationM, 0) / (heights.length || 1);
  if (heights.length === b.sampleCount && Math.abs(mean - b.elevationM) < REPRODUCED_WITHIN_M) {
    reproduced.add(key);
  } else {
    notReproducedLines.add(lineKey(b.segmentId, b.direction));
  }
}
console.log(`rides replayed: ${sessionIds.length} (every ride with a run in the model)`);
console.log(
  `stored buckets the replay reproduces (pass count, and mean within ${REPRODUCED_WITHIN_M} m): ` +
    `${reproduced.size} of ${buckets.length}`,
);
if (notReproducedLines.size > 0) {
  // Which ride differs, from the stored matches: one row per merged run.
  const why = new Map<number, string[]>();
  for (const m of storedMatches) {
    const line = lineKey(m.segmentId, m.direction);
    if (!notReproducedLines.has(line)) continue;
    const replayed = replayedRunsBySessionLine.get(`${m.sessionId}|${line}`) ?? 0;
    if (replayed !== m.runs) {
      const list = why.get(m.sessionId) ?? [];
      list.push(`${line} stored ${m.runs} run(s), replayed ${replayed}`);
      why.set(m.sessionId, list);
    }
  }
  for (const [line, n] of replayedRunsBySessionLine) {
    const [sessionId, l] = line.split("|") as [string, string];
    if (!notReproducedLines.has(l)) continue;
    const stored = storedMatches.find((m) => m.sessionId === Number(sessionId) && lineKey(m.segmentId, m.direction) === l);
    if (!stored) {
      const list = why.get(Number(sessionId)) ?? [];
      list.push(`${l} stored 0 runs, replayed ${n}`);
      why.set(Number(sessionId), list);
    }
  }
  console.log(`  on ${notReproducedLines.size} lines. Rides whose run count differs on them:`);
  for (const [sessionId, list] of [...why].sort((a, b) => a[0] - b[0])) {
    console.log(`    ride ${sessionId}: ${list.slice(0, 4).join("; ")}${list.length > 4 ? `; and ${list.length - 4} more` : ""}`);
  }
  const countsAgree = [...notReproducedLines].filter(
    (l) => ![...why.values()].some((list) => list.some((x) => x.startsWith(`${l} `))),
  );
  if (countsAgree.length > 0) {
    console.log(`  lines where every ride's run count agrees, so a height differs: ${countsAgree.slice(0, 8).join(", ")}${countsAgree.length > 8 ? ", ..." : ""}`);
  }
}

// ---- the pass rows --------------------------------------------------------------

// The replay's passes as the fourth query would return them, for the preview
// below: the server drawing the whole city from each pass's own heights.
const replayRows: PassBucket[] = [];
const matchIdOf = new Map<string, number>();
for (const [key, heights] of passesAt) {
  const [segmentId, direction, distanceM] = key.split("|") as [string, Direction, string];
  for (const h of heights) {
    if (!matchIdOf.has(h.pass)) matchIdOf.set(h.pass, matchIdOf.size + 1);
    replayRows.push({
      segmentId: Number(segmentId),
      direction,
      matchId: matchIdOf.get(h.pass)!,
      distanceM: Number(distanceM),
      elevationM: h.elevationM,
    });
  }
}

// The stored rows, named the way the replay names its passes.
const storedAt = new Map<string, PassHeight[]>();
for (const r of storedPassRows) {
  const key = bucketKey(r.segmentId, r.direction, r.distanceM);
  const list = storedAt.get(key) ?? [];
  list.push({ pass: `${r.sessionId}|${r.firstSampleId}`, sessionId: r.sessionId, nearRideEnds: false, elevationM: r.elevationM });
  storedAt.set(key, list);
}
if (!passTableExists) {
  console.log("stored pass rows: no table yet (migrations/003_pass_buckets.sql), so the map draws every piece from the means");
} else {
  const onFile = buckets.filter(
    (b) => (storedAt.get(bucketKey(b.segmentId, b.direction, b.distanceM))?.length ?? 0) === b.sampleCount,
  ).length;
  let agree = 0;
  for (const [key, rows] of storedAt) {
    const replayed = new Map((passesAt.get(key) ?? []).map((h) => [h.pass, h.elevationM]));
    for (const r of rows) if (Math.abs((replayed.get(r.pass) ?? NaN) - r.elevationM) < REPRODUCED_WITHIN_M) agree++;
  }
  console.log(
    `stored pass rows: ${storedPassRows.length}; buckets with every pass on file: ${onFile} of ${buckets.length}; ` +
      `rows the replay reproduces (same ride and first sample, height within ${REPRODUCED_WITHIN_M} m): ${agree} of ${storedPassRows.length}`,
  );
}

// ---- the four slopes ----------------------------------------------------------

interface Point {
  d: number;
  e: number;
}

const clamp = (pct: number) => Math.max(-MAX_PLAUSIBLE_SLOPE_PCT, Math.min(MAX_PLAUSIBLE_SLOPE_PCT, pct));

/** Least-squares slope in percent, or null where it is undefined. */
function fitPct(points: Point[]): number | null {
  if (points.length < 2) return null;
  const md = points.reduce((s, p) => s + p.d, 0) / points.length;
  const me = points.reduce((s, p) => s + p.e, 0) / points.length;
  let cov = 0;
  let variance = 0;
  for (const p of points) {
    cov += (p.d - md) * (p.e - me);
    variance += (p.d - md) ** 2;
  }
  if (variance === 0) return null;
  const pct = (cov / variance) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/** The alternative that lost: one slope shared by every pass, each at its own level. */
function pooledPct(byPass: Map<string, Point[]>): number | null {
  let cov = 0;
  let variance = 0;
  for (const points of byPass.values()) {
    const md = points.reduce((s, p) => s + p.d, 0) / points.length;
    const me = points.reduce((s, p) => s + p.e, 0) / points.length;
    for (const p of points) {
      cov += (p.d - md) * (p.e - me);
      variance += (p.d - md) ** 2;
    }
  }
  if (variance === 0) return null;
  const pct = (cov / variance) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/** Each pass's own slope, weighted by its bucket count: what the map draws. */
function countWeightedPct(byPass: Map<string, Point[]>): number | null {
  let sum = 0;
  let weight = 0;
  for (const points of byPass.values()) {
    const pct = fitPct(points);
    if (pct === null) continue;
    sum += pct * points.length;
    weight += points.length;
  }
  return weight > 0 ? sum / weight : null;
}

// gradientBuilder.ts's rule, restated: each pass's slope where every pass in
// the window's means is on file and one of them covers two of its buckets, and
// the means' slope otherwise.
function drawnSlope(
  window: ElevationBucket[],
  rowsAt: Map<string, PassHeight[]>,
  mean: number,
): { slope: number; fromPasses: boolean } {
  const keys = window.map((b) => bucketKey(b.segmentId, b.direction, b.distanceM));
  if (!window.every((b, i) => (rowsAt.get(keys[i]!)?.length ?? 0) === b.sampleCount)) {
    return { slope: mean, fromPasses: false };
  }
  const byPass = new Map<string, Point[]>();
  window.forEach((b, i) => {
    for (const h of rowsAt.get(keys[i]!) ?? []) {
      const points = byPass.get(h.pass) ?? [];
      points.push({ d: b.distanceM, e: h.elevationM });
      byPass.set(h.pass, points);
    }
  });
  const pct = countWeightedPct(byPass);
  return pct === null ? { slope: mean, fromPasses: false } : { slope: clamp(pct), fromPasses: true };
}

interface Piece {
  line: string;
  name: string;
  at: string;
  m: number;
  mean: number;
  // What the map draws now, from the stored pass rows where they allow it.
  now: number;
  nowFromPasses: boolean;
  // What the map will draw once every ride's passes are on file.
  preview: number;
  pass: number | null;
  pooled: number | null;
  terrain: number | null;
  // Every bucket in the window reproduces, so its passes are the model's.
  faithful: boolean;
  passes: number;
  nearRideEnds: boolean;
}

const bucketsByLine = new Map<string, ElevationBucket[]>();
for (const b of buckets) {
  const k = lineKey(b.segmentId, b.direction);
  const list = bucketsByLine.get(k) ?? [];
  list.push(b);
  bucketsByLine.set(k, list);
}
const coverageByLine = new Map(coverage.map((c) => [lineKey(c.segmentId, c.direction), c]));
const segById = new Map(segs.map((s) => [s.id, s]));

const pieces: Piece[] = [];
let stops = 0;
const disagreements: string[] = [];
// Twice: as the server draws now, from the stored pass rows, and as it would
// draw with every ride's passes on file, from the replay's.
const drawnNow = segmentsWithLines(segs, buckets, coverage, storedPassRows);
const drawnPreview = segmentsWithLines(segs, buckets, coverage, replayRows);
for (const [s, drawn] of drawnNow.entries()) {
  const segment = segById.get(drawn.id)!;
  const mid = segment.geom.coordinates[Math.floor(segment.geom.coordinates.length / 2)]!;
  for (const [l, line] of drawn.directionalLines.entries()) {
    const previewLine = drawnPreview[s]!.directionalLines[l]!;
    const k = lineKey(drawn.id, line.direction);
    const sorted = [...bucketsByLine.get(k)!].sort((a, b) => a.distanceM - b.distanceM);
    const cov = coverageByLine.get(k);
    // gradientBuilder.ts's extent and fractions, restated.
    const fromM = cov ? Math.max(0, cov.coveredFromM) : Math.max(0, sorted[0]!.distanceM - HALF_BUCKET_M);
    const toM = cov
      ? Math.min(segment.lengthM, cov.coveredToM)
      : Math.min(segment.lengthM, sorted[sorted.length - 1]!.distanceM + HALF_BUCKET_M);
    const lengthM = toM - fromM;
    const fraction = (t: number) =>
      Math.max(0, Math.min(1, line.direction === "forward" ? (t - fromM) / lengthM : (toM - t) / lengthM));
    const spans =
      sorted.length === 1
        ? [{ startM: fromM, endM: toM, window: sorted }]
        : sorted.slice(0, -1).map((b, i) => ({
            startM: i === 0 ? fromM : b.distanceM,
            endM: i === sorted.length - 2 ? toM : sorted[i + 1]!.distanceM,
            window: sorted.slice(Math.max(0, i - SLOPE_WINDOW), Math.min(sorted.length - 1, i + SLOPE_WINDOW + 1) + 1),
          }));
    const mine = spans
      .map((span) => {
        // A line of one bucket is drawn flat, and never fitted.
        const single = sorted.length === 1;
        const mean = single ? 0 : clamp(fitPct(span.window.map((b) => ({ d: b.distanceM, e: b.elevationM }))) ?? 0);
        return {
          f: Math.min(fraction(span.startM), fraction(span.endM)),
          window: span.window,
          mean,
          now: single ? { slope: 0, fromPasses: false } : drawnSlope(span.window, storedAt, mean),
          preview: single ? 0 : drawnSlope(span.window, passesAt, mean).slope,
        };
      })
      .sort((a, b) => a.f - b.f);

    for (const [i, stop] of mine.entries()) {
      stops++;
      const checks = [
        ["now", line.colorStops[i], stop.now.slope],
        ["preview", previewLine.colorStops[i], stop.preview],
      ] as const;
      for (const [label, theirs, slope] of checks) {
        if (stop.f !== theirs?.distanceFraction || colorForSlope(slope) !== theirs.color) {
          disagreements.push(`${label} ${k} stop ${i}: here ${stop.f} ${colorForSlope(slope)}, server ${theirs?.distanceFraction} ${theirs?.color}`);
        }
      }
    }

    const total = turf.length(turf.lineString(line.geometry.coordinates), { units: "meters" });
    for (const [i, stop] of mine.entries()) {
      const m = ((i + 1 < mine.length ? mine[i + 1]!.f : 1) - stop.f) * total;
      if (m <= 0) continue;
      const byPass = new Map<string, Point[]>();
      let nearRideEnds = false;
      for (const b of stop.window) {
        for (const h of passesAt.get(bucketKey(drawn.id, line.direction, b.distanceM)) ?? []) {
          const points = byPass.get(h.pass) ?? [];
          points.push({ d: b.distanceM, e: h.elevationM });
          byPass.set(h.pass, points);
          nearRideEnds ||= h.nearRideEnds;
        }
      }
      const terrainPoints = stop.window.map((b) => ({
        d: b.distanceM,
        e: terrainAt.get(bucketKey(drawn.id, line.direction, b.distanceM)),
      }));
      const pooled = pooledPct(byPass);
      const weighted = countWeightedPct(byPass);
      const terrain =
        sorted.length > 1 && terrainPoints.every((p) => p.e !== undefined)
          ? fitPct(terrainPoints as Point[])
          : null;
      pieces.push({
        line: k,
        name: segment.streetName ?? `(unnamed ${segment.kind})`,
        at: `${mid[1]!.toFixed(5)},${mid[0]!.toFixed(5)}`,
        m,
        mean: stop.mean,
        now: stop.now.slope,
        nowFromPasses: stop.now.fromPasses,
        preview: stop.preview,
        pass: weighted === null ? null : clamp(weighted),
        pooled: pooled === null ? null : clamp(pooled),
        terrain: terrain === null ? null : clamp(terrain),
        faithful: stop.window.every((b) => reproduced.has(bucketKey(drawn.id, line.direction, b.distanceM))),
        passes: byPass.size,
        nearRideEnds,
      });
    }
  }
}

if (disagreements.length > 0) {
  console.log(`REFUSED: ${disagreements.length} of ${stops} colour stops disagree with the server`);
  for (const d of disagreements.slice(0, 10)) console.log(`  ${d}`);
  process.exit(1);
}

// ---- report -----------------------------------------------------------------

const sumM = (ps: Piece[]) => ps.reduce((t, p) => t + p.m, 0);
const km = (m: number) => (m / 1000).toFixed(2);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
const off = (slope: number | null, p: Piece) => Math.abs(slope! - p.terrain!);

console.log(`agreement: all ${stops} colour stops the server draws now match this script's slope`);
console.log(`preview: handed the replay's passes, the server draws all ${stops} stops as this script's each-pass slope`);
console.log(
  `pieces: ${pieces.length}, ${km(sumM(pieces))} km drawn; the map draws each pass's own slope on ` +
    `${km(sumM(pieces.filter((p) => p.nowFromPasses)))} km, the means' on ${km(sumM(pieces.filter((p) => !p.nowFromPasses)))} km\n`,
);

const judged = pieces.filter((p) => p.faithful && p.terrain !== null && p.pass !== null && p.pooled !== null);
const multi = judged.filter((p) => p.passes >= 2);
const moved = judged.filter(
  (p) => Math.abs(p.mean - p.pass!) > ONE_BAND_PCT && colorForSlope(p.mean) !== colorForSlope(p.pass!),
);
const row = (label: string, ps: Piece[]) =>
  console.log(
    `  ${label.padEnd(38)} ${String(ps.length).padStart(6)} ${km(sumM(ps)).padStart(7)}` +
      `   ${median(ps.map((p) => off(p.mean, p))).toFixed(2).padStart(6)}` +
      `   ${median(ps.map((p) => off(p.pass, p))).toFixed(2).padStart(6)}` +
      `   ${median(ps.map((p) => off(p.pooled, p))).toFixed(2).padStart(6)}`,
  );
console.log("SLOPE AGAINST TERRAIN: median |slope - terrain|, in points of slope (lower is closer to the ground)");
console.log(`  ${"".padEnd(38)} ${"pieces".padStart(6)} ${"km".padStart(7)}   ${"mean".padStart(6)}   ${"each".padStart(6)}   ${"pooled".padStart(6)}`);
console.log(`  ${"".padEnd(38)} ${"".padStart(6)} ${"".padStart(7)}   ${"heights".padStart(6)}  ${"pass".padStart(6)}   ${"".padStart(6)}`);
row("every judged piece", judged);
row("judged pieces two or more passes cover", multi);
row("pieces mixing moved more than one band", moved);
console.log(
  `  (judged: the replay reproduces every bucket in the window and the terrain is known; ` +
    `${km(sumM(judged))} of ${km(sumM(pieces))} km)`,
);
const repainted = pieces.filter((p) => colorForSlope(p.preview) !== colorForSlope(p.now));
console.log(
  `  with every ride's passes on file, ${km(sumM(repainted))} km of the ${km(sumM(pieces))} km drawn change colour, ` +
    `${km(sumM(repainted.filter((p) => Math.abs(p.preview - p.now) > ONE_BAND_PCT)))} km of it by more than one band`,
);
const nearShare = sumM(moved.filter((p) => p.nearRideEnds)) / (sumM(moved) || 1);
console.log(
  `  mixing moved the colour more than one band on ${km(sumM(moved))} km of ${new Set(moved.map((p) => p.line)).size} lines; ` +
    `${(100 * nearShare).toFixed(0)}% of it has a pass from a ride's first or last ${NEAR_RIDE_ENDS_MIN} minutes`,
);
const withinBand = (slope: (p: Piece) => number, ps: Piece[]) =>
  sumM(ps.filter((p) => Math.abs(slope(p) - p.terrain!) <= ONE_BAND_PCT)) / (sumM(ps) || 1);
console.log(
  `  share of the multi-pass km within one band (${ONE_BAND_PCT} points) of terrain: mean heights ` +
    `${(100 * withinBand((p) => p.mean, multi)).toFixed(1)}%, each pass ${(100 * withinBand((p) => p.pass!, multi)).toFixed(1)}%`,
);

console.log("\nTHE RIDGEWAY LOT, AND THE CONTROL (steepest piece of each line, by mean heights)");
const fmt = (x: number | null) => (x === null ? "  n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);
const lineReport = (line: string) => {
  const ps = pieces.filter((p) => p.line === line);
  if (ps.length === 0) {
    console.log(`  ${line}: not drawn`);
    return null;
  }
  const worst = ps.reduce((a, b) => (Math.abs(b.mean) > Math.abs(a.mean) ? b : a));
  const steepestPass = ps.reduce((a, b) => (Math.abs(b.pass ?? 0) > Math.abs(a.pass ?? 0) ? b : a));
  console.log(
    `  ${line.padEnd(15)} ${worst.name.slice(0, 22).padEnd(22)} mean heights ${fmt(worst.mean)}, each pass ${fmt(worst.pass)}, ` +
      `pooled ${fmt(worst.pooled)}, terrain ${fmt(worst.terrain)}; steepest by each pass anywhere on the line ` +
      `${fmt(steepestPass.pass)}${ps.every((p) => p.faithful) ? "" : " (not every bucket reproduces)"}`,
  );
  return { worst, steepestPass };
};
for (const line of LOT_LINES) lineReport(line);
const control = lineReport(CONTROL_LINE);

// ---- verdict --------------------------------------------------------------------

console.log("\nVERDICT (each pass against mean heights, judged by terrain)");
const checks: Array<[string, boolean]> = [
  [
    `closer to terrain where mixing moved the colour: ${median(moved.map((p) => off(p.pass, p))).toFixed(2)} ` +
      `vs ${median(moved.map((p) => off(p.mean, p))).toFixed(2)} points`,
    median(moved.map((p) => off(p.pass, p))) < median(moved.map((p) => off(p.mean, p))),
  ],
  [
    `no further from terrain where two or more passes cover a piece: ${median(multi.map((p) => off(p.pass, p))).toFixed(2)} ` +
      `vs ${median(multi.map((p) => off(p.mean, p))).toFixed(2)} points`,
    median(multi.map((p) => off(p.pass, p))) <= median(multi.map((p) => off(p.mean, p))),
  ],
  [
    `the control ${CONTROL_LINE} stays near-black (above ${NEAR_BLACK_ABOVE_PCT}%): each pass ${fmt(control?.steepestPass.pass ?? null)}`,
    (control?.steepestPass.pass ?? 0) > NEAR_BLACK_ABOVE_PCT,
  ],
];
for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
const pass = checks.every(([, ok]) => ok);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
