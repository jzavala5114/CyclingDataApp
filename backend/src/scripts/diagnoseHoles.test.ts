import { test } from "node:test";
import assert from "node:assert/strict";
import { straddlingPair, haversineM, band } from "./diagnoseHoles.js";
import { interiorHoles } from "../services/interiorHoles.js";
import { BUCKET_SIZE_M } from "../services/elevationAggregator.js";

// `straddlingPair` decides which of four causes every hole gets attributed to,
// and the answer decides which fix is the right one. Its first version was
// wrong in a way that changed 143 holes from "the rider rode through this" to
// "no run spans it", so it gets tests.

const at = (atS: number, distanceM: number) => ({
  id: atS,
  atMs: atS * 1000,
  distanceM,
  // A degree of latitude is ~111km, so this puts the fixes a realistic
  // distance apart without making the test about geodesy.
  lat: 38.82 + distanceM / 111_320,
  lon: -104.82,
});

test("THE BUG: a step between the buckets either side of a gap straddles it", () => {
  // A fix at 50m IS the bucket at 45m, and one at 100m IS the bucket at 105m.
  // Comparing the raw 50 against the grid position 45 asks `50 <= 45` and
  // answers no, so the very pair that created both edges of the hole failed to
  // recognise it. This is the case that was miscounted 143 times.
  const hole = interiorHoles([45, 105])[0]!;
  assert.deepEqual(hole, { fromM: 45, toM: 105, gapM: 60, missingBuckets: 3 });
  const found = straddlingPair([at(0, 50), at(4, 100)], hole);
  assert.ok(found, "the pair that produced both edges must recognise its own gap");
  assert.equal(found.gapS, 4);
});

test("a step reaching only one side of the gap is not a crossing", () => {
  const hole = interiorHoles([45, 105])[0]!;
  // 50 -> 70 is bucket 45 -> bucket 75. It entered the gap and stopped.
  assert.equal(straddlingPair([at(0, 50), at(2, 70)], hole), null);
  // 80 -> 100 is bucket 75 -> bucket 105. It left the gap but never entered it
  // from the low side.
  assert.equal(straddlingPair([at(0, 80), at(2, 100)], hole), null);
});

test("a step wider than the gap still straddles it", () => {
  // Another run supplied the buckets at 45 and 105; this run stepped clean
  // over the whole thing from 30 to 120.
  const hole = interiorHoles([45, 105])[0]!;
  assert.ok(straddlingPair([at(0, 30), at(5, 120)], hole));
});

test("direction of travel does not matter", () => {
  // Distances along a backward run still increase with travel, but a rider who
  // doubles back produces a decreasing step, and that step crossed the ground
  // just the same.
  const hole = interiorHoles([45, 105])[0]!;
  const forward = straddlingPair([at(0, 50), at(4, 100)], hole);
  const backward = straddlingPair([at(0, 100), at(4, 50)], hole);
  assert.ok(forward);
  assert.ok(backward);
  assert.equal(backward.gapS, forward.gapS);
});

test("the tightest crossing wins, not the first", () => {
  // Two passes over the same gap in one run: one slow, one quick. The gap is
  // explained by the quick one.
  const hole = interiorHoles([45, 105])[0]!;
  const placed = [at(0, 50), at(40, 100), at(60, 50), at(63, 100)];
  const found = straddlingPair(placed, hole);
  assert.ok(found);
  assert.equal(found.gapS, 3);
});

test("only consecutive fixes count, not any pair", () => {
  // THE ONE THAT MATTERS FOR HONESTY. Fixes at 50 and 100 with a fix at 75 in
  // between mean the bucket at 75 exists, so there is no hole here at all --
  // and if some other hole is passed in, the non-adjacent 50/100 pair must not
  // be allowed to claim it. A test over all pairs would call every gap on the
  // line crossed.
  const hole = interiorHoles([45, 105])[0]!;
  assert.equal(straddlingPair([at(0, 50), at(2, 75), at(4, 100)], hole), null);
});

test("a run with fewer than two fixes crosses nothing", () => {
  const hole = interiorHoles([45, 105])[0]!;
  assert.equal(straddlingPair([], hole), null);
  assert.equal(straddlingPair([at(0, 50)], hole), null);
});

test("the ground distance is the distance between the two fixes", () => {
  const hole = interiorHoles([45, 105])[0]!;
  const found = straddlingPair([at(0, 50), at(4, 100)], hole);
  assert.ok(found);
  // 50m apart in latitude, so ~50m of ground. Loose because the fixture places
  // them by dividing by a nominal metres-per-degree.
  assert.ok(Math.abs(found.groundM - 50) < 1, `got ${found.groundM}`);
});

test("a one-bucket gap is not a hole, so nothing is asked of it", () => {
  assert.deepEqual(interiorHoles([45, 45 + BUCKET_SIZE_M]), []);
});

test("haversine agrees with a known separation", () => {
  // One degree of latitude at the equator, against the textbook ~110.57km.
  assert.ok(Math.abs(haversineM(0, 0, 1, 0) - 111_195) < 700);
  assert.equal(haversineM(38.82, -104.82, 38.82, -104.82), 0);
});

test("the gap bands name the band a duration falls in", () => {
  assert.equal(band(0), "<=5s");
  assert.equal(band(5), "<=5s");
  assert.equal(band(5.1), "<=15s");
  assert.equal(band(45), "<=45s");
  assert.equal(band(46), "<=120s");
  assert.equal(band(3600), ">120s");
});
