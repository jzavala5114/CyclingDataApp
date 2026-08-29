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
import { smoothElevations } from "./elevationSmoothing.js";
import { demKey, ensureDemElevations, type DemPosition } from "./demElevation.js";
import type { Direction, Segment, SessionSample } from "../types/index.js";

// Candidate segments come from a box around the session's own samples. Fine
// for a prototype where a session is one short ride.
const BBOX_PAD_DEG = 0.005; // ~500m

// Below this many overlapping points the offset is being fit to noise, so the
// ride is merged on its own GPS baseline instead -- no worse than before the
// DEM existed, and better than shifting a whole ride by a bad number.
const MIN_DEM_POINTS_FOR_ANCHOR = 10;

// A barometer that has drifted, or a GPS baseline taken on a bad first fix,
// lands tens of metres out. Anything past this is not drift, it is a broken
// ride, and silently shifting it onto the DEM would hide the fault.
const MAX_PLAUSIBLE_ANCHOR_OFFSET_M = 60;

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
  // or null if it was merged unanchored.
  demOffsetM: number | null;
  demPoints: number;
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
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// One scalar for the whole ride, not one per segment: the error being removed
// is a constant baseline error, and fitting per segment would absorb the real
// terrain along with it. The median rather than the mean so a bridge, a
// tunnel or a handful of bad fixes can't drag the whole ride.
function fitDemOffset(runs: QualifyingRun[], dem: Map<string, number>): number | null {
  const residuals: number[] = [];
  for (const run of runs) {
    for (const bucket of run.buckets) {
      const reference = dem.get(
        demKey({ segmentId: run.segment.id, direction: run.direction, distanceM: bucket.distanceM }),
      );
      if (reference == null) continue;
      residuals.push(bucket.elevationM - reference);
    }
  }

  if (residuals.length < MIN_DEM_POINTS_FOR_ANCHOR) return null;
  const offset = median(residuals);
  if (Math.abs(offset) > MAX_PLAUSIBLE_ANCHOR_OFFSET_M) {
    console.warn(`DEM offset ${offset.toFixed(1)}m is implausible, merging unanchored`);
    return null;
  }
  return offset;
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
    return { matchedRuns: 0, discardedRuns: 0, demOffsetM: null, demPoints: 0, discards: [] };
  }

  const lats = sampleRows.map((s) => s.lat);
  const lons = sampleRows.map((s) => s.lon);
  const { rows: segmentRows } = await client.query<Segment>(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
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

  const smoothed = smoothElevations(sampleRows);
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
  const demOffsetM = fitDemOffset(qualifying, dem);
  const demPoints = positions.filter((p) => dem.has(demKey(p))).length;

  for (const run of qualifying) {
    await mergeBuckets(
      client,
      run.segment.id,
      run.direction,
      demOffsetM == null
        ? run.buckets
        : run.buckets.map((b) => ({ ...b, elevationM: b.elevationM - demOffsetM })),
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
    demOffsetM,
    demPoints,
    discards,
  };
}
