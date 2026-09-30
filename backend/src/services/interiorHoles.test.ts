import { test } from "node:test";
import assert from "node:assert/strict";
import { interiorHoles } from "./interiorHoles.js";
import { BUCKET_SIZE_M } from "./elevationAggregator.js";

test("a full line has no holes", () => {
  assert.deepEqual(interiorHoles([0, 15, 30, 45, 60]), []);
});

test("nothing to compare is not a hole", () => {
  assert.deepEqual(interiorHoles([]), []);
  assert.deepEqual(interiorHoles([45]), []);
});

test("one missing bucket is one hole", () => {
  assert.deepEqual(interiorHoles([0, 15, 45, 60]), [
    { fromM: 15, toM: 45, gapM: 30, missingBuckets: 1 },
  ]);
});

test("a wider gap counts the buckets inside it", () => {
  assert.deepEqual(interiorHoles([0, 90]), [
    { fromM: 0, toM: 90, gapM: 90, missingBuckets: 5 },
  ]);
});

test("several holes in one line are all reported, in order along the line", () => {
  assert.deepEqual(interiorHoles([0, 30, 45, 90, 105]), [
    { fromM: 0, toM: 30, gapM: 30, missingBuckets: 1 },
    { fromM: 45, toM: 90, gapM: 45, missingBuckets: 2 },
  ]);
});

test("the gap is measured against the grid, not against zero", () => {
  // BOUNDARY. Exactly one bucket apart is a continuous line and must never be
  // reported: at 15m that is every healthy pair on the map, so an off-by-one
  // here would call all 966 lines broken.
  assert.deepEqual(interiorHoles([0, BUCKET_SIZE_M]), []);
  // One metre more is a hole. The buckets are on a 15m grid so this cannot
  // actually occur, which is the point -- it pins the comparison rather than
  // a real case.
  assert.equal(interiorHoles([0, BUCKET_SIZE_M + 1]).length, 1);
  assert.deepEqual(interiorHoles([0, BUCKET_SIZE_M - 1]), []);
});

test("holes are found the same way whatever order the rows arrive in", () => {
  // The driver hands over whatever the database returns. A missing `order by`
  // must not change the answer, or the tool's number depends on the planner.
  const shuffled = [90, 0, 45, 105, 30];
  assert.deepEqual(interiorHoles(shuffled), interiorHoles([...shuffled].sort((a, b) => a - b)));
  assert.equal(interiorHoles(shuffled).length, 2);
});

test("a repeated distance is not a zero-width hole", () => {
  assert.deepEqual(interiorHoles([0, 15, 15, 30]), []);
  assert.deepEqual(interiorHoles([0, 0, 45]), [
    { fromM: 0, toM: 45, gapM: 45, missingBuckets: 2 },
  ]);
});

test("a non-finite distance is dropped rather than poisoning the run", () => {
  // The frontage measure was once taken from 0.21 to exactly 1.0 by a single
  // NaN coordinate, because the disagreeing leg vanished from both sides of a
  // ratio. Here a NaN sorts arbitrarily and every comparison against it is
  // false, so it would invent a hole on one side and hide one on the other.
  assert.deepEqual(interiorHoles([0, 15, NaN, 30]), []);
  assert.deepEqual(interiorHoles([0, Infinity, 45]), [
    { fromM: 0, toM: 45, gapM: 45, missingBuckets: 2 },
  ]);
});

test("a non-default bucket size is honoured", () => {
  // The grid width is a constant in elevationAggregator.ts and has moved once
  // already (5m -> 15m). If it moves again, a tool hardcoding 15 would report
  // every line as one long hole, so the parameter exists and is tested.
  assert.deepEqual(interiorHoles([0, 5, 10], 5), []);
  assert.equal(interiorHoles([0, 5, 10], 5).length, 0);
  assert.equal(interiorHoles([0, 10], 5).length, 1);
  // And the default really is the aggregator's constant, not a copy.
  assert.equal(interiorHoles([0, BUCKET_SIZE_M]).length, interiorHoles([0, BUCKET_SIZE_M], BUCKET_SIZE_M).length);
  assert.equal(interiorHoles([0, 30]).length, interiorHoles([0, 30], BUCKET_SIZE_M).length);
});

test("a bucket size of zero or less is a caller bug, not a silent answer", () => {
  // Every gap is > 0, so a zero width would report a hole between every pair
  // of buckets on the map and look like a catastrophe rather than a bug here.
  assert.throws(() => interiorHoles([0, 15], 0), /must be positive/);
  assert.throws(() => interiorHoles([0, 15], -15), /must be positive/);
  assert.throws(() => interiorHoles([0, 15], NaN), /must be positive/);
});

test("a real line with a real hole: segment 17973 Hancock, 15m to 90m of 91m", () => {
  // From the sidewalk fold on 2026-09-27: after folding, Hancock #17973 went
  // from drawing nothing to drawing 15-90m of its 91m. Those six buckets are
  // continuous, so the recovered line has no interior hole -- only end gaps,
  // which are a different problem with a different cause.
  assert.deepEqual(interiorHoles([15, 30, 45, 60, 75, 90]), []);
});
