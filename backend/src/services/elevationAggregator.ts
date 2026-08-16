import * as turf from "@turf/turf";
import type { PoolClient } from "pg";
import type { Direction, MatchedRun, Segment } from "../types/index.js";

// Wider buckets mean more raw samples get averaged into each one (see the
// per-bucket averaging in bucketizeRun below) and slope gets computed over
// a longer baseline in gradientBuilder.ts, both of which shrink how much a
// given amount of barometer noise can swing the reported slope. 5m made a
// single noisy reading swing slope by several percent -- comparable to the
// color-band thresholds themselves; 15m still resolves block-scale terrain
// changes without amplifying sensor noise into the result.
export const BUCKET_SIZE_M = 15;

// Crossing an intersection -- or just waiting at one -- drops a fix or two on
// the cross street. Those samples are real and correctly matched: they sit
// within metres of the cross street and point along it. What they are not is
// a ride down it. Merged anyway, a single point gave a 77m stretch of
// Sahwatch Street and a 139m stretch of South Institute Street a full-length
// gradient line apiece, invented from one elevation reading.
//
// So a run has to cover ground before it counts. Neither test works alone: a
// pure distance threshold throws away short connector pieces that really were
// ridden end to end, and a pure fraction lets a touch on a very short segment
// through. Measured over the 147 runs recorded so far the two populations
// hardly overlap -- touches span a median of 0m, genuine traversals 60m+ --
// so these thresholds sit in a wide empty gap rather than on a judgement call.
const MIN_SPAN_M = 25;
const MIN_COVERAGE = 0.35;

export interface BucketSample {
  distanceM: number;
  elevationM: number;
}

interface RunProfile {
  buckets: BucketSample[];
  // Distance between the first and last point of the run measured along the
  // segment, not as the crow flies -- a rider stopped at a light produces
  // scattered fixes that span metres of noise but no distance travelled.
  spanM: number;
}

// Projects each sample in a run onto the segment's line and rounds its
// distance-along-segment to the nearest bucket, averaging samples that land
// in the same bucket within this one run.
function bucketizeRun(run: MatchedRun, segment: Segment): RunProfile {
  const line = turf.lineString(segment.geom.coordinates);
  const sums = new Map<number, { total: number; count: number }>();
  let minDistance = Infinity;
  let maxDistance = -Infinity;

  for (const sample of run.samples) {
    const point = turf.point([sample.lon, sample.lat]);
    const snapped = turf.nearestPointOnLine(line, point, { units: "meters" });
    const distanceFromStart = snapped.properties.location ?? 0;
    const distanceAlongDirection =
      run.direction === "forward" ? distanceFromStart : segment.lengthM - distanceFromStart;

    minDistance = Math.min(minDistance, distanceAlongDirection);
    maxDistance = Math.max(maxDistance, distanceAlongDirection);

    const bucket = Math.round(distanceAlongDirection / BUCKET_SIZE_M) * BUCKET_SIZE_M;
    const entry = sums.get(bucket) ?? { total: 0, count: 0 };
    entry.total += sample.elevationM;
    entry.count += 1;
    sums.set(bucket, entry);
  }

  return {
    buckets: [...sums.entries()].map(([distanceM, { total, count }]) => ({
      distanceM,
      elevationM: total / count,
    })),
    spanM: run.samples.length > 0 ? maxDistance - minDistance : 0,
  };
}

// Buckets one run, or returns null if it only clipped the segment rather than
// riding it. Kept separate from the merge so the caller can look at every
// qualifying run's buckets as a set -- the DEM anchoring in sessionProcessor
// needs the whole session's profile before any of it is written.
export function profileRun(run: MatchedRun, segment: Segment): BucketSample[] | null {
  const { buckets, spanM } = bucketizeRun(run, segment);
  if (spanM < MIN_SPAN_M && spanM / segment.lengthM < MIN_COVERAGE) return null;
  return buckets;
}

// Folds one run's buckets into the persistent running mean for each (segment,
// direction, distance bucket) -- never overwrites, always blends with whatever
// is already stored so repeated rides refine the profile instead of replacing
// it.
export async function mergeBuckets(
  client: PoolClient,
  segmentId: number,
  direction: Direction,
  buckets: BucketSample[],
): Promise<void> {
  for (const bucket of buckets) {
    await client.query(
      `insert into segment_elevation_buckets (segment_id, direction, distance_m, elevation_m, sample_count)
       values ($1, $2, $3, $4, 1)
       on conflict (segment_id, direction, distance_m) do update set
         elevation_m = (segment_elevation_buckets.elevation_m * segment_elevation_buckets.sample_count + excluded.elevation_m)
                        / (segment_elevation_buckets.sample_count + 1),
         sample_count = segment_elevation_buckets.sample_count + 1,
         updated_at = now()`,
      [segmentId, direction, bucket.distanceM, bucket.elevationM],
    );
  }
}
