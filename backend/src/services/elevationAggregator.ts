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
// through.
//
// The span is measured across the fixes either side of the run as well as the
// run's own. Fixes land ~11m apart, so a rider crossing a 10m stretch of trail
// at speed may only get one inside it and score a span of zero -- 23 lines
// vanished that way in one ride, showing up as gaps in an otherwise
// continuous route. The fixes just before and just after bracket the crossing
// and measure it properly. A perpendicular touch stays near zero either way,
// because moving along the street you are actually on barely moves your
// projection onto the one you are crossing.
//
// Bracketing inflates every span, so the fraction is stricter than it would be
// on the run's own samples: 0.7 keeps the five phantom lines reported from
// real rides dead while restoring the legitimate short crossings.
// Exported so the rebuild script can report discards against the same numbers
// the gate actually applied, rather than a second copy that could drift out of
// step with this one.
export const MIN_SPAN_M = 25;
export const MIN_COVERAGE = 0.7;

export interface BucketSample {
  distanceM: number;
  elevationM: number;
}

export interface RunProfile {
  buckets: BucketSample[];
  // The stretch of segment this run covered, measured along the direction of
  // travel. On a pass-through the bracketing fixes fall outside the segment
  // and clamp to its ends, so this reaches 0 and lengthM exactly -- which is
  // how the renderer knows to draw right up to the intersection.
  coveredFromM: number;
  coveredToM: number;
  // Distance between the first and last point of the run measured along the
  // segment, not as the crow flies -- a rider stopped at a light produces
  // scattered fixes that span metres of noise but no distance travelled.
  spanM: number;
}

// The fixes immediately before and after a run. Only their position is used,
// never their elevation -- they were recorded somewhere else.
export interface RunNeighbours {
  before?: { lat: number; lon: number };
  after?: { lat: number; lon: number };
}

// Projects each sample in a run onto the segment's line and rounds its
// distance-along-segment to the nearest bucket, averaging samples that land
// in the same bucket within this one run.
function bucketizeRun(
  run: MatchedRun,
  segment: Segment,
  neighbours: RunNeighbours,
): RunProfile {
  const line = turf.lineString(segment.geom.coordinates);
  const sums = new Map<number, { total: number; count: number }>();
  let minDistance = Infinity;
  let maxDistance = -Infinity;

  // nearestPointOnLine clamps to the line, so a fix taken just before the
  // segment starts projects onto its start and one taken just after the end
  // projects onto its end -- which is exactly the extent being measured.
  const distanceAlong = (point: { lat: number; lon: number }) => {
    const snapped = turf.nearestPointOnLine(line, turf.point([point.lon, point.lat]), {
      units: "meters",
    });
    const distanceFromStart = snapped.properties.location ?? 0;
    return run.direction === "forward" ? distanceFromStart : segment.lengthM - distanceFromStart;
  };

  for (const sample of run.samples) {
    const distanceAlongDirection = distanceAlong(sample);
    minDistance = Math.min(minDistance, distanceAlongDirection);
    maxDistance = Math.max(maxDistance, distanceAlongDirection);

    const bucket = Math.round(distanceAlongDirection / BUCKET_SIZE_M) * BUCKET_SIZE_M;
    const entry = sums.get(bucket) ?? { total: 0, count: 0 };
    entry.total += sample.elevationM;
    entry.count += 1;
    sums.set(bucket, entry);
  }

  for (const neighbour of [neighbours.before, neighbours.after]) {
    if (!neighbour) continue;
    const distanceAlongDirection = distanceAlong(neighbour);
    minDistance = Math.min(minDistance, distanceAlongDirection);
    maxDistance = Math.max(maxDistance, distanceAlongDirection);
  }

  return {
    buckets: [...sums.entries()].map(([distanceM, { total, count }]) => ({
      distanceM,
      elevationM: total / count,
    })),
    coveredFromM: Math.max(0, minDistance),
    coveredToM: Math.min(segment.lengthM, maxDistance),
    spanM: run.samples.length > 0 ? maxDistance - minDistance : 0,
  };
}

// What the traversal gate measured, and what it decided. Returned whether or
// not the run passed: a rejected run used to vanish leaving only a counter, so
// there was no way to tell a genuine intersection touch from a real traversal
// that the matcher had chopped into pieces too short to qualify. Those need
// opposite fixes, so the difference has to be visible.
export interface RunAssessment {
  profile: RunProfile;
  qualified: boolean;
  spanM: number;
  // spanM as a share of the whole segment. The gate accepts either a long
  // enough absolute span or a large enough share, so both are reported.
  coverageFraction: number;
}

// Buckets one run and judges whether it rode the segment or merely clipped it.
// Kept separate from the merge so the caller can look at every qualifying run's
// buckets as a set -- the DEM anchoring in sessionProcessor needs the whole
// session's profile before any of it is written.
export function assessRun(
  run: MatchedRun,
  segment: Segment,
  neighbours: RunNeighbours = {},
): RunAssessment {
  const profile = bucketizeRun(run, segment, neighbours);
  const { spanM } = profile;
  const coverageFraction = segment.lengthM > 0 ? spanM / segment.lengthM : 0;
  return {
    profile,
    qualified: spanM >= MIN_SPAN_M || coverageFraction >= MIN_COVERAGE,
    spanM,
    coverageFraction,
  };
}

// Folds one run's buckets into the persistent running mean for each (segment,
// direction, distance bucket) -- never overwrites, always blends with whatever
// is already stored so repeated rides refine the profile instead of replacing
// it.
// One statement per run rather than one per bucket. A 35-minute ride produces
// ~600 buckets, and a round trip to Supabase is ~150ms, so writing them
// individually took longer than the phone was willing to wait -- the ride was
// matched and committed server-side while the app reported a timeout.
//
// Batched per run, not per session: a rider who covers the same segment twice
// in one ride produces the same key twice, and Postgres refuses to let ON
// CONFLICT DO UPDATE touch a row twice in a single statement. Within one run
// the keys are unique, because bucketizeRun already collapses them into a map.
export async function mergeBuckets(
  client: PoolClient,
  segmentId: number,
  direction: Direction,
  buckets: BucketSample[],
): Promise<void> {
  if (buckets.length === 0) return;

  const values: unknown[] = [];
  const tuples = buckets.map((bucket, i) => {
    values.push(segmentId, direction, bucket.distanceM, bucket.elevationM);
    const n = i * 4;
    return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, 1)`;
  });

  await client.query(
    `insert into segment_elevation_buckets (segment_id, direction, distance_m, elevation_m, sample_count)
     values ${tuples.join(", ")}
     on conflict (segment_id, direction, distance_m) do update set
       elevation_m = (segment_elevation_buckets.elevation_m * segment_elevation_buckets.sample_count + excluded.elevation_m)
                      / (segment_elevation_buckets.sample_count + 1),
       sample_count = segment_elevation_buckets.sample_count + 1,
       updated_at = now()`,
    values,
  );
}

// Widens the stretch of a segment known to have been ridden. Union rather than
// replace: two rides covering different halves of a street between them cover
// all of it.
export async function mergeCoverage(
  client: PoolClient,
  segmentId: number,
  direction: Direction,
  fromM: number,
  toM: number,
): Promise<void> {
  await client.query(
    `insert into segment_coverage (segment_id, direction, covered_from_m, covered_to_m)
     values ($1, $2, $3, $4)
     on conflict (segment_id, direction) do update set
       covered_from_m = least(segment_coverage.covered_from_m, excluded.covered_from_m),
       covered_to_m = greatest(segment_coverage.covered_to_m, excluded.covered_to_m),
       updated_at = now()`,
    [segmentId, direction, fromM, toM],
  );
}
