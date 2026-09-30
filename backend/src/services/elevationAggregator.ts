import * as turf from "@turf/turf";
import type { PoolClient } from "pg";
import { ANCHOR_MAX_GAP_S, type EndNeighbours } from "./segmentMatcher.js";
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

/**
 * Where along a segment a position falls, measured in the direction of travel.
 *
 * Returns a closure because the line is built once per segment and reused for
 * every sample; building it per call showed up in the matcher's profile.
 *
 * Exported so anything asking "which bucket would this fix land in" gets the
 * same answer the merge did. A second copy of this projection is how a
 * diagnostic ends up disagreeing with the thing it is diagnosing.
 */
export function distanceAlongFor(
  segment: Segment,
  direction: Direction,
): (point: { lat: number; lon: number }) => number {
  const line = turf.lineString(segment.geom.coordinates);
  // nearestPointOnLine clamps to the line, so a fix taken just before the
  // segment starts projects onto its start and one taken just after the end
  // projects onto its end -- which is exactly the extent being measured.
  return (point) => {
    const snapped = turf.nearestPointOnLine(line, turf.point([point.lon, point.lat]), {
      units: "meters",
    });
    const distanceFromStart = snapped.properties.location ?? 0;
    return direction === "forward" ? distanceFromStart : segment.lengthM - distanceFromStart;
  };
}

/** The grid position a distance-along rounds to. */
export const bucketFor = (distanceAlongM: number): number =>
  Math.round(distanceAlongM / BUCKET_SIZE_M) * BUCKET_SIZE_M;

// Projects each sample in a run onto the segment's line and rounds its
// distance-along-segment to the nearest bucket, averaging samples that land
// in the same bucket within this one run.
function bucketizeRun(
  run: MatchedRun,
  segment: Segment,
  neighbours: RunNeighbours,
): RunProfile {
  const sums = new Map<number, { total: number; count: number }>();
  let minDistance = Infinity;
  let maxDistance = -Infinity;

  const distanceAlong = distanceAlongFor(segment, run.direction);

  for (const sample of run.samples) {
    const distanceAlongDirection = distanceAlong(sample);
    minDistance = Math.min(minDistance, distanceAlongDirection);
    maxDistance = Math.max(maxDistance, distanceAlongDirection);

    const bucket = bucketFor(distanceAlongDirection);
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

// How far apart the bracketing fix and the run's own first fix may be before a
// pass-through stops being provable.
//
// The two are consecutive fixes by construction, so this is one sampling
// interval -- measured at a median of 4s across the archive. Past it there was
// a dropout, and a dropout is precisely when a rider could have left the route
// and come back. Deliberately the matcher's own ANCHOR_MAX_GAP_S: that is
// already this codebase's answer to "how long does the last known position keep
// vouching for where you can be", and having two numbers for one question is
// how they drift apart.
export { ANCHOR_MAX_GAP_S as MAX_PASSTHROUGH_GAP_S } from "./segmentMatcher.js";

/** Whether the rider provably entered and left through the segment's own ends. */
export interface Passage {
  /** A connected segment held the previous fix, close enough in time. */
  enteredThrough: boolean;
  /** A connected segment held the next fix. */
  exitedThrough: boolean;
}

/** A fix adjacent to a run: which segment held it, and how long before/after. */
export interface AdjacentFix {
  segmentId: number | null;
  gapS: number;
}

/**
 * Did the rider arrive through this segment's own ends, or start mid-block?
 *
 * The two ends swap with direction and this is the only place that knows it:
 * travel distance 0 is the geometry's first coordinate going forward and its
 * last coordinate going backward, so a backward run entering "at 0" is
 * physically arriving at the `end` of the geometry. Getting this the wrong way
 * round would extend every line away from the join the rider actually crossed.
 */
export function passageFor(
  direction: Direction,
  neighbours: EndNeighbours,
  before: AdjacentFix | null,
  after: AdjacentFix | null,
  maxGapS: number = ANCHOR_MAX_GAP_S,
): Passage {
  const atZero = direction === "forward" ? neighbours.start : neighbours.end;
  const atLength = direction === "forward" ? neighbours.end : neighbours.start;
  const through = (fix: AdjacentFix | null, side: ReadonlySet<number>) =>
    fix != null && fix.segmentId != null && fix.gapS <= maxGapS && side.has(fix.segmentId);
  return {
    enteredThrough: through(before, atZero),
    exitedThrough: through(after, atLength),
  };
}

/**
 * Widens a run's covered extent to the ends the rider provably came through.
 *
 * `bucketizeRun` measures coverage from the fixes themselves, bracketed by the
 * fix either side. That is right when a ride starts mid-block, and wrong at
 * every boundary a rider crosses: `SWITCH_MARGIN_M` deliberately holds a run on
 * its old segment for a fix or two past the join, so the bracketing fix is
 * already *inside* the new segment and coverage starts there. Measured across
 * the archive that costs 6,885m of unpainted road, 3,951m of it at the
 * artificial 150m cuts `split_ways.mjs` makes mid-block -- which is why the map
 * shows gaps in places with no junction.
 *
 * A rider on a connected segment one fix ago, and on this one now, crossed the
 * join between them. The ground from the join to the first fix was ridden, so
 * the line is drawn to it. Nothing is invented: no bucket is added and no
 * elevation is guessed, only the extent already implied by the route.
 *
 * This deliberately does NOT clamp on distance. A run whose first fix is 100m
 * into a 150m piece still reaches the join if the previous consecutive fix was
 * on the neighbour there -- that is a dropout crossed at speed, and refusing it
 * would reintroduce the gap the rule exists to close. The time bound is what
 * separates that from a rider who left and came back.
 */
export function clampCoverageToPassage(
  profile: RunProfile,
  segment: Segment,
  passage: Passage,
): { coveredFromM: number; coveredToM: number } {
  return {
    coveredFromM: passage.enteredThrough ? 0 : profile.coveredFromM,
    coveredToM: passage.exitedThrough ? segment.lengthM : profile.coveredToM,
  };
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
