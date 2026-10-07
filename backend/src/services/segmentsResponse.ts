import { buildDirectionalGradientLines } from "./gradientBuilder.js";
import type { Direction, ElevationBucket, Segment, SegmentCoverage } from "../types/index.js";

// What GET /segments sends: each segment with its directional gradient lines.
//
// The three inputs come from three queries and are joined here, in JS: buckets
// and coverage are filed under `ElevationBucket.segmentId` and
// `SegmentCoverage.segmentId`, then looked up with `Segment.id`. All three are
// bigint columns, and a JS Map matches keys by type as well as value, so if one
// side ever arrives as text while the other is a number, every lookup misses.
// A missed bucket lookup ships the street with no line at all, a missed
// coverage lookup draws it to the wrong extent, and neither throws.
// db/pgTypes.ts is what makes all three numbers; segmentsResponse.test.ts holds
// this join to rows built by that driver. It lived inline in the route until a
// cold review broke it there and every test still passed.
export function segmentsWithLines(
  segmentRows: readonly Segment[],
  bucketRows: readonly ElevationBucket[],
  coverageRows: readonly SegmentCoverage[],
) {
  const bucketsBySegment = new Map<number, Record<Direction, ElevationBucket[]>>();
  for (const bucket of bucketRows) {
    const forSegment = bucketsBySegment.get(bucket.segmentId) ?? { forward: [], backward: [] };
    forSegment[bucket.direction].push(bucket);
    bucketsBySegment.set(bucket.segmentId, forSegment);
  }

  const coverageBySegment = new Map<number, Partial<Record<Direction, SegmentCoverage>>>();
  for (const coverage of coverageRows) {
    const forSegment = coverageBySegment.get(coverage.segmentId) ?? {};
    forSegment[coverage.direction] = coverage;
    coverageBySegment.set(coverage.segmentId, forSegment);
  }

  return segmentRows.map((segment) => ({
    id: segment.id,
    streetName: segment.streetName,
    geom: segment.geom,
    lengthM: segment.lengthM,
    directionalLines: buildDirectionalGradientLines(
      segment,
      bucketsBySegment.get(segment.id) ?? { forward: [], backward: [] },
      coverageBySegment.get(segment.id) ?? {},
    ),
  }));
}
