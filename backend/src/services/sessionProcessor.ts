import type { PoolClient } from "pg";
import { matchSamplesToSegments } from "./segmentMatcher.js";
import { mergeBuckets, profileRun, type BucketSample } from "./elevationAggregator.js";
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

export interface ProcessResult {
  matchedRuns: number;
  discardedRuns: number;
  // Metres subtracted from this ride to line it up with the terrain model,
  // or null if it was merged unanchored.
  demOffsetM: number | null;
  demPoints: number;
}

interface QualifyingRun {
  segment: Segment;
  direction: Direction;
  buckets: BucketSample[];
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
            elevation_m as "elevationM", heading_deg as "headingDeg",
            speed_mps as "speedMps", accuracy_m as "accuracyM"
       from session_samples where session_id = $1 order by recorded_at`,
    [sessionId],
  );

  if (sampleRows.length === 0) {
    return { matchedRuns: 0, discardedRuns: 0, demOffsetM: null, demPoints: 0 };
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

  const runs = matchSamplesToSegments(smoothElevations(sampleRows), segmentRows);
  const segmentsById = new Map(segmentRows.map((s) => [s.id, s]));

  // Bucket everything first and write nothing yet: the anchor offset is fit
  // across the whole ride, so no part of it can be merged until all of it has
  // been measured.
  const qualifying: QualifyingRun[] = [];
  for (const run of runs) {
    const segment = segmentsById.get(run.segmentId);
    if (!segment) continue;
    // Runs that only clipped a segment -- crossing it at an intersection, or
    // sitting at a light beside it -- are dropped rather than merged, so they
    // can't invent a gradient line for a street that was never ridden.
    const buckets = profileRun(run, segment);
    if (!buckets) continue;
    qualifying.push({
      segment,
      direction: run.direction,
      buckets,
      firstSampleId: run.samples[0].id,
      lastSampleId: run.samples[run.samples.length - 1].id,
    });
  }

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
  };
}
