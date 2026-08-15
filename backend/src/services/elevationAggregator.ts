import * as turf from "@turf/turf";
import type { PoolClient } from "pg";
import type { MatchedRun, Segment } from "../types/index.js";

// Wider buckets mean more raw samples get averaged into each one (see the
// per-bucket averaging in bucketizeRun below) and slope gets computed over
// a longer baseline in gradientBuilder.ts, both of which shrink how much a
// given amount of barometer noise can swing the reported slope. 5m made a
// single noisy reading swing slope by several percent -- comparable to the
// color-band thresholds themselves; 15m still resolves block-scale terrain
// changes without amplifying sensor noise into the result.
export const BUCKET_SIZE_M = 15;

interface BucketSample {
  distanceM: number;
  elevationM: number;
}

// Projects each sample in a run onto the segment's line and rounds its
// distance-along-segment to the nearest bucket, averaging samples that land
// in the same bucket within this one run.
function bucketizeRun(run: MatchedRun, segment: Segment): BucketSample[] {
  const line = turf.lineString(segment.geom.coordinates);
  const sums = new Map<number, { total: number; count: number }>();

  for (const sample of run.samples) {
    const point = turf.point([sample.lon, sample.lat]);
    const snapped = turf.nearestPointOnLine(line, point, { units: "meters" });
    const distanceFromStart = snapped.properties.location ?? 0;
    const distanceAlongDirection =
      run.direction === "forward" ? distanceFromStart : segment.lengthM - distanceFromStart;

    const bucket = Math.round(distanceAlongDirection / BUCKET_SIZE_M) * BUCKET_SIZE_M;
    const entry = sums.get(bucket) ?? { total: 0, count: 0 };
    entry.total += sample.elevationM;
    entry.count += 1;
    sums.set(bucket, entry);
  }

  return [...sums.entries()].map(([distanceM, { total, count }]) => ({
    distanceM,
    elevationM: total / count,
  }));
}

// Folds one session's bucketed samples into the persistent running mean for
// each (segment, direction, distance bucket) -- never overwrites, always
// blends with whatever is already stored so repeated rides refine the
// profile instead of replacing it.
export async function mergeRunIntoElevationModel(
  client: PoolClient,
  run: MatchedRun,
  segment: Segment,
): Promise<void> {
  const buckets = bucketizeRun(run, segment);

  for (const bucket of buckets) {
    await client.query(
      `insert into segment_elevation_buckets (segment_id, direction, distance_m, elevation_m, sample_count)
       values ($1, $2, $3, $4, 1)
       on conflict (segment_id, direction, distance_m) do update set
         elevation_m = (segment_elevation_buckets.elevation_m * segment_elevation_buckets.sample_count + excluded.elevation_m)
                        / (segment_elevation_buckets.sample_count + 1),
         sample_count = segment_elevation_buckets.sample_count + 1,
         updated_at = now()`,
      [segment.id, run.direction, bucket.distanceM, bucket.elevationM],
    );
  }
}
