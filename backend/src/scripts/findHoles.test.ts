import { test } from "node:test";
import assert from "node:assert/strict";
import { holesByLine, type BucketRow } from "./findHoles.js";

// The gap rule itself is tested in services/interiorHoles.test.ts. This covers
// the grouping, which is the part that can silently merge two lines into one or
// split one into two -- either of which moves the headline count without
// touching a single hole.

const row = (over: Partial<BucketRow> = {}): BucketRow => ({
  segment_id: "100",
  direction: "forward",
  distance_m: 0,
  street_name: "Hancock Expressway",
  kind: "road",
  length_m: 91,
  is_tunnel: false,
  folded: false,
  ...over,
});

const line = (
  segmentId: string,
  direction: string,
  distances: number[],
  over: Partial<BucketRow> = {},
): BucketRow[] =>
  distances.map((distance_m) => row({ segment_id: segmentId, direction, distance_m, ...over }));

test("a line with no gap is left out entirely", () => {
  assert.deepEqual(holesByLine(line("100", "forward", [0, 15, 30])), []);
});

test("a line with a gap is reported once, with its holes", () => {
  const result = holesByLine(line("100", "forward", [0, 15, 45, 60]));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.segmentId, "100");
  assert.equal(result[0]!.direction, "forward");
  assert.deepEqual(result[0]!.holes, [{ fromM: 15, toM: 45, gapM: 30, missingBuckets: 1 }]);
});

test("the two directions of one segment are separate lines", () => {
  // THE GROUPING THAT MATTERS. Forward and backward share a segment id and a
  // geometry but are drawn as two lines and ridden independently. Keying on
  // the segment alone would pool their distances, and interleaved buckets
  // would then hide every hole on both.
  const rows = [...line("100", "forward", [0, 45]), ...line("100", "backward", [0, 45])];
  const result = holesByLine(rows);
  assert.equal(result.length, 2);
  assert.deepEqual(new Set(result.map((r) => r.direction)), new Set(["forward", "backward"]));
  for (const r of result) assert.equal(r.holes.length, 1);
});

test("interleaved directions do not fill each other's holes", () => {
  // The same rows keyed on segment alone would read 0,15,30,45 -- continuous,
  // no holes at all -- while each direction is really missing a bucket.
  const rows = [...line("100", "forward", [0, 30]), ...line("100", "backward", [15, 45])];
  const result = holesByLine(rows);
  assert.equal(result.length, 2);
  assert.equal(result.reduce((n, r) => n + r.holes.length, 0), 2);
});

test("two segments are never merged, even in the same street", () => {
  const rows = [...line("100", "forward", [0, 45]), ...line("101", "forward", [0, 45])];
  assert.equal(holesByLine(rows).length, 2);
  // And a string id is compared as a string: `segments.id` is a bigserial and
  // node-postgres hands it back as text, which is the bug that made
  // evalLinkerFold print n/a for its headline number.
  assert.deepEqual(
    holesByLine(rows).map((r) => r.segmentId).sort(),
    ["100", "101"],
  );
});

test("rows arrive in any order and the line still groups", () => {
  const rows = [
    row({ segment_id: "100", direction: "forward", distance_m: 45 }),
    row({ segment_id: "101", direction: "backward", distance_m: 0 }),
    row({ segment_id: "100", direction: "forward", distance_m: 0 }),
    row({ segment_id: "101", direction: "backward", distance_m: 45 }),
  ];
  const result = holesByLine(rows);
  assert.equal(result.length, 2);
  for (const r of result) assert.equal(r.holes.length, 1);
});

test("the line carries the segment's own metadata", () => {
  const result = holesByLine(
    line("100", "forward", [0, 45], {
      street_name: "Gold Camp Road",
      kind: "road",
      length_m: 55,
      is_tunnel: true,
      folded: true,
    }),
  );
  assert.equal(result[0]!.streetName, "Gold Camp Road");
  assert.equal(result[0]!.lengthM, 55);
  assert.equal(result[0]!.isTunnel, true);
  assert.equal(result[0]!.folded, true);
});

test("is_tunnel travels with the line, because the whole split depends on it", () => {
  // If the flag were dropped in the grouping, every hole would land in the
  // "defects to explain" column and the tool would report exactly what it
  // reported before the flag existed -- looking like the flag had found
  // nothing rather than like the tool had lost it.
  const rows = [
    ...line("100", "forward", [0, 45], { is_tunnel: true }),
    ...line("101", "forward", [0, 45], { is_tunnel: false }),
  ];
  const result = holesByLine(rows);
  assert.equal(result.filter((r) => r.isTunnel).length, 1);
  assert.equal(result.filter((r) => !r.isTunnel).length, 1);
});

test("an unnamed segment keeps its null name rather than being dropped", () => {
  const result = holesByLine(line("100", "forward", [0, 45], { street_name: null }));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.streetName, null);
});

test("the widest hole sorts first", () => {
  const rows = [
    ...line("100", "forward", [0, 30]), // 30m
    ...line("101", "forward", [0, 90]), // 90m
    ...line("102", "forward", [0, 45]), // 45m
  ];
  assert.deepEqual(
    holesByLine(rows).map((r) => r.segmentId),
    ["101", "102", "100"],
  );
});

test("a line with several holes sorts on its widest, not its first", () => {
  const rows = [
    ...line("100", "forward", [0, 30, 45, 135]), // holes of 30m and 90m
    ...line("101", "forward", [0, 60]), // one hole of 60m
  ];
  assert.deepEqual(
    holesByLine(rows).map((r) => r.segmentId),
    ["100", "101"],
  );
  assert.equal(holesByLine(rows)[0]!.holes.length, 2);
});

test("no buckets at all produces no lines", () => {
  assert.deepEqual(holesByLine([]), []);
});
