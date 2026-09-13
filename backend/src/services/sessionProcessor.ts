import type { PoolClient } from "pg";
import { matchSamplesToSegments, stitchFragmentedRuns } from "./segmentMatcher.js";
import {
  assessRun,
  mergeBuckets,
  mergeCoverage,
  MIN_COVERAGE,
  MIN_SPAN_M,
  type BucketSample,
} from "./elevationAggregator.js";
import { rejectElevationSpikes, smoothElevations } from "./elevationSmoothing.js";
import { demKey, ensureDemElevations, type DemPosition } from "./demElevation.js";
import { fitAnchor, MIN_POINTS_FOR_ANCHOR, type AnchorPoint, type Revisit } from "./anchorFit.js";
import type { Direction, Segment, SessionSample } from "../types/index.js";

// Candidate segments come from a box around the session's own samples. Fine
// for a prototype where a session is one short ride.
const BBOX_PAD_DEG = 0.005; // ~500m

// One run the traversal gate rejected, with the measurements behind the
// decision. A rejection has two very different causes that a bare count cannot
// tell apart: a genuine intersection touch, which SHOULD be rejected, and a
// real traversal the matcher chopped into pieces too short to qualify, which
// should not. `stitchedSpanM` is what separates them -- it is how far this run
// and every other run on the same segment and direction reach between them, so
// a fragment shows a large stitched span while a touch stays near zero.
export interface DiscardedRun {
  segmentId: number;
  streetName: string | null;
  kind: string;
  direction: Direction;
  segmentLengthM: number;
  spanM: number;
  coverageFraction: number;
  sampleCount: number;
  // How many runs in this session landed on the same segment and direction.
  // More than one means the traversal was broken up.
  runsOnSameSegment: number;
  stitchedSpanM: number;
  stitchedWouldQualify: boolean;
  // Seconds between the previous run on this same segment+direction ending and
  // this one starting; null if this is the first. Fragments of one traversal
  // are separated by a dropped fix or two, so a few seconds. Two genuinely
  // separate crossings of the same block are minutes apart. This is the signal
  // that lets stitching tell them apart.
  gapToPreviousRunS: number | null;
}

export interface ProcessResult {
  matchedRuns: number;
  discardedRuns: number;
  // Metres subtracted from this ride to line it up with the terrain model,
  // taken at the middle of the measured window, or null if it merged
  // unanchored.
  demOffsetM: number | null;
  // How much that correction changed across the stretch of the ride the drift
  // was measured over -- not the whole ride, since the ramp is held flat
  // outside that window. Zero when the fit fell back to a single number. This
  // is the ride disagreeing with itself over time, measured from places it
  // covered twice, so it owes nothing to the terrain model.
  demDriftM: number | null;
  demAnchorShape: "ramp" | "constant" | null;
  demPoints: number;
  // Fixes dropped for claiming a physically impossible height. Reported so a
  // ride that is mostly spikes is visible rather than silently thinned.
  rejectedSpikes: number;
  // Diagnostics only -- never written to the database, and stripped from the
  // API response. The rebuild script aggregates these.
  discards: DiscardedRun[];
}

interface QualifyingRun {
  segment: Segment;
  direction: Direction;
  buckets: BucketSample[];
  coveredFromM: number;
  coveredToM: number;
  firstSampleId: number;
  lastSampleId: number;
  // When this traversal happened, so the anchor can vary through the ride.
  // The midpoint of the run, not per bucket: a run is one pass over one
  // segment, ten to thirty seconds, and the weather does not move in that.
  atMs: number;
}

// Not one scalar per segment: fitting that finely would absorb the real terrain
// along with the error. These set the ride's overall level only -- the slope
// comes from the revisits below, for reasons set out in anchorFit.ts.
function collectAnchorPoints(runs: QualifyingRun[], dem: Map<string, number>): AnchorPoint[] {
  const points: AnchorPoint[] = [];
  for (const run of runs) {
    for (const bucket of run.buckets) {
      const reference = dem.get(
        demKey({ segmentId: run.segment.id, direction: run.direction, distanceM: bucket.distanceM }),
      );
      if (reference == null) continue;
      points.push({ atMs: run.atMs, residualM: bucket.elevationM - reference });
    }
  }
  return points;
}

// Every pair of passes over ground this ride covered twice, and how much its
// reading moved between them. Same segment, same direction, same 15m cell, so
// the hill and the terrain model's error at that spot both cancel and most of
// what is left is the barometer sliding. See anchorFit.ts for how much "most"
// is: this cancels the ground to within where in the cell each pass sampled and
// the smoothing's speed-dependent lag, not exactly.
//
// **One comparison per pair of passes, not per bucket.** A single out-and-back
// over one block touches four or five buckets, but they all share the same two
// moments and the same disagreement. Emitting one revisit per bucket let that
// single comparison satisfy a quorum meant to need three independent ones, and
// made a median of four copies of one number look like a robust estimate.
//
// **Directions are kept apart, and the second reason is why that is not just
// an indexing detail somebody should tidy up later.** The first reason is
// indexing: a bucket's distance is measured along the direction of travel, so
// forward 30m and backward 30m are opposite ends of the segment and not the
// same ground at all. That much could be repaired by pairing forward `d`
// against backward `lengthM - d`.
//
// The second cannot be repaired. smoothElevations is a causal EMA, so the
// height it reports for a spot is really the height a little way BACK along the
// direction of travel. Two passes the same way round share that displacement,
// so it cancels except for the difference in their speeds -- the ~0.5m leak
// anchorFit.ts bounds, and it vanishes entirely when both passes ride at the
// same speed. Two passes in opposite directions are displaced in OPPOSITE
// directions along the ground, so the term is 2 x lag x grade and it never
// cancels: around 1.2m on a 6% street even at identical speeds. That is larger
// than the floor the drift has to clear to be believed at all, and it is signed
// by gradient rather than random, so it would not average away across pairs.
// It would read as drift, on exactly the hilly rides this is meant to help.
//
// The cost of that is real and measured: 21 long revisits across the archive
// are declined for direction against 30 kept. Using them needs the lag removed
// first, not just the index flipped.
export function collectRevisits(
  runs: Array<{ segmentId: number; direction: Direction; atMs: number; buckets: BucketSample[] }>,
): Revisit[] {
  const byBucket = new Map<string, Array<{ run: number; elevationM: number }>>();
  runs.forEach((run, index) => {
    for (const bucket of run.buckets) {
      const key = `${run.segmentId}|${run.direction}|${bucket.distanceM}`;
      const readings = byBucket.get(key);
      const reading = { run: index, elevationM: bucket.elevationM };
      if (readings) readings.push(reading);
      else byBucket.set(key, [reading]);
    }
  });

  // Every bucket two passes share contributes one rise to that pair of passes.
  const risesByPair = new Map<string, number[]>();
  for (const readings of byBucket.values()) {
    if (readings.length < 2) continue;
    for (let i = 0; i < readings.length; i++) {
      for (let j = i + 1; j < readings.length; j++) {
        const a = readings[i];
        const b = readings[j];
        const [early, late] = runs[a.run].atMs <= runs[b.run].atMs ? [a, b] : [b, a];
        const key = `${early.run}|${late.run}`;
        const rise = late.elevationM - early.elevationM;
        const rises = risesByPair.get(key);
        if (rises) rises.push(rise);
        else risesByPair.set(key, [rise]);
      }
    }
  }

  const revisits: Revisit[] = [];
  for (const [key, rises] of risesByPair) {
    const [earlyIndex, lateIndex] = key.split("|").map(Number);
    // The median across the buckets the two passes share, so one bad cell in a
    // long shared stretch cannot set the comparison.
    const sorted = [...rises].sort((x, y) => x - y);
    const mid = Math.floor(sorted.length / 2);
    revisits.push({
      earlyAtMs: runs[earlyIndex].atMs,
      lateAtMs: runs[lateIndex].atMs,
      riseM: sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
      buckets: rises.length,
    });
  }
  return revisits;
}

// Map-matches a session's samples against nearby segments and folds the
// result into the persistent elevation model.
//
// Shared by POST /sessions/:id/end and the offline rebuild, so that
// reprocessing old rides goes through exactly the same matching, gating and
// averaging as a ride coming off the phone -- a rebuild that drifted from the
// live path would quietly produce a model the app could never reproduce.
//
// Everything runs on the caller's client so the whole thing is one
// transaction: a session either lands in the model completely or not at all.
export async function processSession(
  client: PoolClient,
  sessionId: number,
): Promise<ProcessResult> {
  const { rows: sampleRows } = await client.query<SessionSample>(
    `select id, session_id as "sessionId", recorded_at as "recordedAt", lat, lon,
            elevation_m as "elevationM", elevation_source as "elevationSource",
            altitude_accuracy_m as "altitudeAccuracyM", heading_deg as "headingDeg",
            speed_mps as "speedMps", accuracy_m as "accuracyM"
       from session_samples where session_id = $1 order by recorded_at`,
    [sessionId],
  );

  if (sampleRows.length === 0) {
    return {
      matchedRuns: 0, discardedRuns: 0, demOffsetM: null, demDriftM: null,
      demAnchorShape: null, demPoints: 0, rejectedSpikes: 0, discards: [],
    };
  }

  const lats = sampleRows.map((s) => s.lat);
  const lons = sampleRows.map((s) => s.lon);
  const { rows: segmentRows } = await client.query<Segment>(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            piece_index as "pieceIndex",
            ST_AsGeoJSON(geom)::json as geom, length_m as "lengthM", bearing_deg as "bearingDeg"
       from segments
      where geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        -- Sidewalks are represented by the road they run alongside, so only
        -- canonical geometry is a match candidate. Riding the sidewalk still
        -- matches, via the parent road a few metres away.
        and canonical_segment_id is null`,
    [
      Math.min(...lons) - BBOX_PAD_DEG,
      Math.min(...lats) - BBOX_PAD_DEG,
      Math.max(...lons) + BBOX_PAD_DEG,
      Math.max(...lats) + BBOX_PAD_DEG,
    ],
  );

  // Spikes are removed before the EMA, not after: smoothing an impossible
  // reading spreads it over the fixes around it instead of deleting it, so by
  // the time it reaches the buckets it has contaminated its neighbours too.
  const { kept, rejected: rejectedSpikes } = rejectElevationSpikes(sampleRows);
  const smoothed = smoothElevations(kept);
  // Rejoined before gating, not after: the gate judges whether a run covered
  // ground, and a traversal chopped into pieces cannot answer that honestly.
  const runs = stitchFragmentedRuns(matchSamplesToSegments(smoothed, segmentRows));
  const segmentsById = new Map(segmentRows.map((s) => [s.id, s]));
  // Used to hand each run the fix either side of it, so a short segment
  // crossed between two fixes can still be shown to have been ridden.
  const orderById = new Map(smoothed.map((s, i) => [s.id, i]));

  // Bucket everything first and write nothing yet: the anchor offset is fit
  // across the whole ride, so no part of it can be merged until all of it has
  // been measured.
  const qualifying: QualifyingRun[] = [];
  const rejected: Array<{ run: (typeof runs)[number]; segment: Segment; assessment: ReturnType<typeof assessRun> }> = [];
  // Every run's reach along its segment, kept per segment+direction so a
  // traversal broken into fragments can be recognised afterwards.
  const reachByKey = new Map<string, { from: number; to: number; runs: number }>();
  const keyFor = (segmentId: number, direction: Direction) => `${segmentId}|${direction}`;
  // When the previous run on each segment+direction finished, so the gap to the
  // next one can be measured. Runs arrive in chronological order.
  const lastEndByKey = new Map<string, number>();
  const gapByRun = new Map<(typeof runs)[number], number | null>();

  for (const run of runs) {
    const segment = segmentsById.get(run.segmentId);
    if (!segment) continue;
    // Runs that only clipped a segment -- crossing it at an intersection, or
    // sitting at a light beside it -- are dropped rather than merged, so they
    // can't invent a gradient line for a street that was never ridden.
    const firstIndex = orderById.get(run.samples[0].id) ?? 0;
    const lastIndex = orderById.get(run.samples[run.samples.length - 1].id) ?? 0;
    const assessment = assessRun(run, segment, {
      before: firstIndex > 0 ? smoothed[firstIndex - 1] : undefined,
      after: lastIndex < smoothed.length - 1 ? smoothed[lastIndex + 1] : undefined,
    });
    const { profile } = assessment;

    const key = keyFor(segment.id, run.direction);
    const reach = reachByKey.get(key) ?? { from: Infinity, to: -Infinity, runs: 0 };
    reach.from = Math.min(reach.from, profile.coveredFromM);
    reach.to = Math.max(reach.to, profile.coveredToM);
    reach.runs += 1;
    reachByKey.set(key, reach);

    const startedMs = Date.parse(run.samples[0].recordedAt);
    const endedMs = Date.parse(run.samples[run.samples.length - 1].recordedAt);
    const previousEndMs = lastEndByKey.get(key);
    gapByRun.set(run, previousEndMs == null ? null : (startedMs - previousEndMs) / 1000);
    lastEndByKey.set(key, endedMs);

    if (!assessment.qualified) {
      rejected.push({ run, segment, assessment });
      continue;
    }
    qualifying.push({
      segment,
      direction: run.direction,
      buckets: profile.buckets,
      coveredFromM: profile.coveredFromM,
      coveredToM: profile.coveredToM,
      firstSampleId: run.samples[0].id,
      lastSampleId: run.samples[run.samples.length - 1].id,
      atMs: (startedMs + endedMs) / 2,
    });
  }

  // Filled in after the loop because the stitched reach isn't known until every
  // run has been seen.
  const discards: DiscardedRun[] = rejected.map(({ run, segment, assessment }) => {
    const reach = reachByKey.get(keyFor(segment.id, run.direction))!;
    const stitchedSpanM = Math.max(0, reach.to - reach.from);
    const stitchedFraction = segment.lengthM > 0 ? stitchedSpanM / segment.lengthM : 0;
    return {
      segmentId: segment.id,
      streetName: segment.streetName,
      kind: segment.kind,
      direction: run.direction,
      segmentLengthM: segment.lengthM,
      spanM: assessment.spanM,
      coverageFraction: assessment.coverageFraction,
      sampleCount: run.samples.length,
      runsOnSameSegment: reach.runs,
      stitchedSpanM,
      stitchedWouldQualify: stitchedSpanM >= MIN_SPAN_M || stitchedFraction >= MIN_COVERAGE,
      gapToPreviousRunS: gapByRun.get(run) ?? null,
    };
  });

  const positions: DemPosition[] = qualifying.flatMap((run) =>
    run.buckets.map((bucket) => ({
      segmentId: run.segment.id,
      direction: run.direction,
      distanceM: bucket.distanceM,
    })),
  );
  const dem = await ensureDemElevations(client, positions);
  const anchor = fitAnchor(
    collectAnchorPoints(qualifying, dem),
    collectRevisits(qualifying.map((r) => ({
      segmentId: r.segment.id, direction: r.direction, atMs: r.atMs, buckets: r.buckets,
    }))),
  );
  const demPoints = positions.filter((p) => dem.has(demKey(p))).length;
  if (anchor == null) {
    // Distinguish the two causes, because they call for opposite responses: too
    // little terrain is a coverage problem, an implausible offset is a broken
    // ride. Carrying the number is what made the old warning actionable.
    const covered = collectAnchorPoints(qualifying, dem);
    console.warn(
      covered.length < MIN_POINTS_FOR_ANCHOR
        ? `only ${covered.length} DEM points, merging unanchored`
        : `DEM offset is implausible over ${covered.length} points, merging unanchored`,
    );
  }

  for (const run of qualifying) {
    // Evaluated at this run's own moment, so a ride that slid during the hour
    // is put back on one level instead of being tilted around its average.
    const correctionM = anchor?.offsetAt(run.atMs);
    await mergeBuckets(
      client,
      run.segment.id,
      run.direction,
      correctionM == null
        ? run.buckets
        : run.buckets.map((b) => ({ ...b, elevationM: b.elevationM - correctionM })),
    );
    await mergeCoverage(client, run.segment.id, run.direction, run.coveredFromM, run.coveredToM);
    await client.query(
      `insert into session_segment_matches
         (session_id, segment_id, direction, first_sample_id, last_sample_id)
       values ($1, $2, $3, $4, $5)`,
      [sessionId, run.segment.id, run.direction, run.firstSampleId, run.lastSampleId],
    );
  }

  return {
    matchedRuns: qualifying.length,
    discardedRuns: runs.length - qualifying.length,
    demOffsetM: anchor?.midM ?? null,
    demDriftM: anchor?.driftM ?? null,
    demAnchorShape: anchor?.shape ?? null,
    demPoints,
    rejectedSpikes: rejectedSpikes.length,
    discards,
  };
}
