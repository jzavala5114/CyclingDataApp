import { BUCKET_SIZE_M } from "./elevationAggregator.js";

// A hole is ground inside a drawn line that has no elevation value.
//
// Buckets sit on a fixed grid anchored at the segment start -- the aggregator
// rounds every sample to `Math.round(d / BUCKET_SIZE_M) * BUCKET_SIZE_M` -- so
// consecutive buckets are exactly one bucket apart and nothing else is
// possible. Two that are further apart therefore mean one or more grid
// positions between them got no sample, which renders as an unpainted stretch
// between two coloured ones.
//
// This is deliberately not the same question as coverage. `segment_coverage`
// records how far along a segment a ride reached, and a line that stops short
// of the kerb is an end gap with its own cause (see the coverage note in
// context/session.md). A hole is strictly interior: there is a value before it
// and a value after it, so whatever happened, the rider was demonstrably on
// both sides of it.

export interface Hole {
  /** Distance of the last bucket before the gap, in metres along the direction of travel. */
  readonly fromM: number;
  /** Distance of the first bucket after the gap. */
  readonly toM: number;
  /** `toM - fromM`. One bucket wide means no hole, so every hole here is at least two. */
  readonly gapM: number;
  /** How many grid positions inside the gap have no value. */
  readonly missingBuckets: number;
}

/**
 * The interior holes in one drawn line, given the bucket distances it has.
 *
 * Order does not matter and duplicates are collapsed, so the caller can hand
 * over rows straight from the database without an `order by` and without
 * worrying whether the primary key already forbids duplicates.
 */
export function interiorHoles(
  distancesM: readonly number[],
  bucketSizeM: number = BUCKET_SIZE_M,
): Hole[] {
  if (!(bucketSizeM > 0)) throw new Error(`bucketSizeM must be positive, got ${bucketSizeM}`);

  // `distance_m` is `integer not null`, so a non-finite value cannot come out
  // of the database. Dropped anyway because NaN makes every comparison false:
  // it would sort to an arbitrary place and then invent a hole on one side of
  // itself and hide one on the other, which is the failure mode that cost a
  // day on the frontage measure.
  const sorted = [...new Set(distancesM.filter((d) => Number.isFinite(d)))].sort((a, b) => a - b);

  const holes: Hole[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const fromM = sorted[i - 1]!;
    const toM = sorted[i]!;
    const gapM = toM - fromM;
    if (gapM <= bucketSizeM) continue;
    holes.push({ fromM, toM, gapM, missingBuckets: Math.round(gapM / bucketSizeM) - 1 });
  }
  return holes;
}
