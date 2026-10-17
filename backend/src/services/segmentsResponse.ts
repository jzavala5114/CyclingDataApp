import { buildDirectionalGradientLines } from "./gradientBuilder.js";
import type { Direction, ElevationBucket, PassBucket, Segment, SegmentCoverage } from "../types/index.js";

// What GET /segments sends: each segment with its directional gradient lines.
//
// The four inputs come from four queries and are joined here, in JS: buckets,
// coverage and pass rows are filed under `ElevationBucket.segmentId`,
// `SegmentCoverage.segmentId` and `PassBucket.segmentId`, then looked up with
// `Segment.id`. All four are bigint columns, and a JS Map matches keys by type
// as well as value, so if one side ever arrives as text while the other is a
// number, every lookup misses. A missed bucket lookup ships the street with no
// line at all, a missed coverage lookup draws it to the wrong extent, a missed
// pass lookup quietly draws it from the means and brings back the cliffs the
// pass rows exist to remove, and none of them throws.
// db/pgTypes.ts is what makes all four numbers; segmentsResponse.test.ts holds
// this join to rows built by that driver. It lived inline in the route until a
// cold review broke it there and every test still passed.
export function segmentsWithLines(
  segmentRows: readonly Segment[],
  bucketRows: readonly ElevationBucket[],
  coverageRows: readonly SegmentCoverage[],
  passRows: readonly PassBucket[] = [],
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

  const passesBySegment = new Map<number, Partial<Record<Direction, PassBucket[]>>>();
  for (const pass of passRows) {
    const forSegment = passesBySegment.get(pass.segmentId) ?? {};
    (forSegment[pass.direction] ??= []).push(pass);
    passesBySegment.set(pass.segmentId, forSegment);
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
      passesBySegment.get(segment.id) ?? {},
    ),
  }));
}
