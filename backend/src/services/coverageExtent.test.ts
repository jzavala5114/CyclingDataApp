import { test } from "node:test";
import assert from "node:assert/strict";
import {
  passageFor,
  clampCoverageToPassage,
  MAX_PASSTHROUGH_GAP_S,
  type RunProfile,
} from "./elevationAggregator.js";
import { buildEndAdjacency, ANCHOR_MAX_GAP_S } from "./segmentMatcher.js";
import type { EndNeighbours } from "./segmentMatcher.js";
import type { Segment } from "../types/index.js";

// The coverage clamp decides how far a drawn line reaches. Too timid and the
// map keeps the 6,885m of blank it has today; too eager and it paints ground
// nobody rode, which is the failure that made buildDirectionalGradientLines
// clip to coverage in the first place (a rider who clipped 45m of a 129m
// footway got the full 129m drawn, 80m of it into a park).

// -- buildEndAdjacency --------------------------------------------------------

let nextId = 1;
const seg = (over: Partial<Segment> = {}): Segment =>
  ({
    id: nextId++,
    osmWayId: 900,
    kind: "road",
    streetName: "Test Street",
    startNodeId: 1,
    endNodeId: 2,
    pieceIndex: 0,
    lengthM: 100,
    bearingDeg: 0,
    geom: { type: "LineString", coordinates: [[-104.82, 38.82], [-104.82, 38.821]] },
    ...over,
  }) as Segment;

test("two segments meeting at a node are neighbours at the ends that meet", () => {
  const a = seg({ id: 10, startNodeId: 1, endNodeId: 2 });
  const b = seg({ id: 11, osmWayId: 901, startNodeId: 2, endNodeId: 3 });
  const ends = buildEndAdjacency([a, b]);
  assert.deepEqual([...ends.get(10)!.end], [11]);
  assert.deepEqual([...ends.get(10)!.start], []);
  assert.deepEqual([...ends.get(11)!.start], [10]);
  assert.deepEqual([...ends.get(11)!.end], []);
});

test("a segment touching nothing has two empty ends, not a missing entry", () => {
  const ends = buildEndAdjacency([seg({ id: 10, startNodeId: 7, endNodeId: 8 })]);
  assert.deepEqual(ends.get(10), { start: new Set(), end: new Set() });
});

test("cap slices of one run are joined by piece order, nose to tail", () => {
  // THE CASE THIS EXISTS FOR. All three carry the run's node pair 1->2, so
  // node identity alone would say every slice meets every other slice at both
  // ends. Only consecutive pieces actually touch, and piece i's START is piece
  // i-1's END.
  const p0 = seg({ id: 20, pieceIndex: 0, startNodeId: 1, endNodeId: 2 });
  const p1 = seg({ id: 21, pieceIndex: 1, startNodeId: 1, endNodeId: 2 });
  const p2 = seg({ id: 22, pieceIndex: 2, startNodeId: 1, endNodeId: 2 });
  const ends = buildEndAdjacency([p0, p1, p2]);
  assert.deepEqual([...ends.get(20)!.end], [21]);
  assert.deepEqual([...ends.get(20)!.start], []);
  assert.deepEqual([...ends.get(21)!.start], [20]);
  assert.deepEqual([...ends.get(21)!.end], [22]);
  assert.deepEqual([...ends.get(22)!.start], [21]);
  assert.deepEqual([...ends.get(22)!.end], []);
});

test("a middle slice gets NO node neighbours, because its ends are not nodes", () => {
  // THE ONE THAT PREVENTS AN INVENTED LINE. A middle slice's node ids are the
  // run's ends, up to 150m away in each direction. A cross street recorded
  // against that end would let the clamp paint to a join the rider never
  // crossed -- and paint it from the wrong end of the slice.
  const p0 = seg({ id: 30, pieceIndex: 0, startNodeId: 1, endNodeId: 2 });
  const p1 = seg({ id: 31, pieceIndex: 1, startNodeId: 1, endNodeId: 2 });
  const p2 = seg({ id: 32, pieceIndex: 2, startNodeId: 1, endNodeId: 2 });
  const crossAtStart = seg({ id: 33, osmWayId: 901, startNodeId: 1, endNodeId: 9 });
  const crossAtEnd = seg({ id: 34, osmWayId: 902, startNodeId: 2, endNodeId: 9 });
  const ends = buildEndAdjacency([p0, p1, p2, crossAtStart, crossAtEnd]);

  assert.deepEqual([...ends.get(31)!.start], [30], "middle slice keeps only its sibling");
  assert.deepEqual([...ends.get(31)!.end], [32]);
  // The outer slices DO reach the run's nodes and keep the cross streets.
  assert.ok(ends.get(30)!.start.has(33));
  assert.ok(ends.get(32)!.end.has(34));
  // And the cross streets do not think they touch the middle slice.
  assert.equal(ends.get(33)!.start.has(31), false);
  assert.equal(ends.get(34)!.start.has(31), false);
});

test("a run digitised the other way round is still one family", () => {
  const p0 = seg({ id: 40, pieceIndex: 0, startNodeId: 5, endNodeId: 6 });
  const p1 = seg({ id: 41, pieceIndex: 1, startNodeId: 6, endNodeId: 5 });
  const ends = buildEndAdjacency([p0, p1]);
  assert.deepEqual([...ends.get(40)!.end], [41]);
  assert.deepEqual([...ends.get(41)!.start], [40]);
});

test("two pieces of one way with DIFFERENT node pairs are separate chunks", () => {
  // Not cap slices: a way that was split at a real intersection produces two
  // chunks, each with its own node pair, both piece 0. They meet at the node.
  const a = seg({ id: 50, pieceIndex: 0, startNodeId: 1, endNodeId: 2 });
  const b = seg({ id: 51, pieceIndex: 0, startNodeId: 2, endNodeId: 3 });
  const ends = buildEndAdjacency([a, b]);
  assert.deepEqual([...ends.get(50)!.end], [51]);
  assert.deepEqual([...ends.get(51)!.start], [50]);
});

test("a gap in the piece indexes is a real gap and is not bridged", () => {
  const p0 = seg({ id: 60, pieceIndex: 0, startNodeId: 1, endNodeId: 2 });
  const p2 = seg({ id: 61, pieceIndex: 2, startNodeId: 1, endNodeId: 2 });
  const ends = buildEndAdjacency([p0, p2]);
  assert.deepEqual([...ends.get(60)!.end], []);
  assert.deepEqual([...ends.get(61)!.start], []);
});

test("three ways meeting at one node all see each other there", () => {
  const a = seg({ id: 70, osmWayId: 901, startNodeId: 1, endNodeId: 2 });
  const b = seg({ id: 71, osmWayId: 902, startNodeId: 2, endNodeId: 3 });
  const c = seg({ id: 72, osmWayId: 903, startNodeId: 2, endNodeId: 4 });
  const ends = buildEndAdjacency([a, b, c]);
  assert.deepEqual([...ends.get(70)!.end].sort(), [71, 72]);
  assert.ok(ends.get(71)!.start.has(72));
  assert.ok(ends.get(72)!.start.has(71));
});

// -- passageFor ---------------------------------------------------------------

const neighbours = (start: number[], end: number[]): EndNeighbours => ({
  start: new Set(start),
  end: new Set(end),
});

test("arriving from a connected segment means the rider came through that end", () => {
  const p = passageFor("forward", neighbours([5], [6]), { segmentId: 5, gapS: 4 }, null);
  assert.deepEqual(p, { enteredThrough: true, exitedThrough: false });
});

test("leaving onto a connected segment means the rider went out through that end", () => {
  const p = passageFor("forward", neighbours([5], [6]), null, { segmentId: 6, gapS: 4 });
  assert.deepEqual(p, { enteredThrough: false, exitedThrough: true });
});

test("THE DIRECTION SWAP: backward travel enters at the geometry's END", () => {
  // Travel distance 0 is the first coordinate going forward and the LAST one
  // going backward. A backward run arriving "at 0" is physically arriving at
  // the geometry's end, so the neighbour that proves it is the one recorded
  // against `end`. Getting this backwards would extend every backward line
  // away from the join actually crossed -- and every street here is drawn in
  // both directions, so it would be wrong half the time and look right half
  // the time.
  const n = neighbours([5], [6]);
  assert.deepEqual(passageFor("backward", n, { segmentId: 6, gapS: 4 }, null), {
    enteredThrough: true,
    exitedThrough: false,
  });
  assert.deepEqual(passageFor("backward", n, { segmentId: 5, gapS: 4 }, null), {
    enteredThrough: false,
    exitedThrough: false,
  });
  assert.deepEqual(passageFor("backward", n, null, { segmentId: 5, gapS: 4 }), {
    enteredThrough: false,
    exitedThrough: true,
  });
});

test("a fix on a segment that does not touch this end proves nothing", () => {
  const p = passageFor("forward", neighbours([5], [6]), { segmentId: 99, gapS: 1 }, null);
  assert.equal(p.enteredThrough, false);
});

test("a fix matched to nothing proves nothing", () => {
  const p = passageFor("forward", neighbours([5], [6]), { segmentId: null, gapS: 1 }, null);
  assert.equal(p.enteredThrough, false);
});

test("no fix at all -- the ride started here -- proves nothing", () => {
  assert.deepEqual(passageFor("forward", neighbours([5], [6]), null, null), {
    enteredThrough: false,
    exitedThrough: false,
  });
});

test("BOUNDARY: the time bound is the matcher's own, and it bites", () => {
  const n = neighbours([5], [6]);
  assert.equal(MAX_PASSTHROUGH_GAP_S, ANCHOR_MAX_GAP_S, "one number for one question");
  assert.equal(
    passageFor("forward", n, { segmentId: 5, gapS: MAX_PASSTHROUGH_GAP_S }, null).enteredThrough,
    true,
  );
  assert.equal(
    passageFor("forward", n, { segmentId: 5, gapS: MAX_PASSTHROUGH_GAP_S + 0.1 }, null)
      .enteredThrough,
    false,
    "past the bound there was a dropout, and a dropout is when a rider could have left",
  );
  // In seconds, not minutes or milliseconds.
  assert.equal(MAX_PASSTHROUGH_GAP_S, 15);
});

test("the bound is overridable, so a sweep can measure it through this code", () => {
  const n = neighbours([5], [6]);
  assert.equal(passageFor("forward", n, { segmentId: 5, gapS: 30 }, null, 45).enteredThrough, true);
  assert.equal(passageFor("forward", n, { segmentId: 5, gapS: 30 }, null, 5).enteredThrough, false);
});

// -- clampCoverageToPassage ---------------------------------------------------

const profile = (from: number, to: number): RunProfile => ({
  buckets: [],
  coveredFromM: from,
  coveredToM: to,
  spanM: to - from,
});

test("a proven pass-through covers the whole segment", () => {
  const extent = clampCoverageToPassage(profile(3.5, 71), seg({ lengthM: 75.4 }), {
    enteredThrough: true,
    exitedThrough: true,
  });
  assert.deepEqual(extent, { coveredFromM: 0, coveredToM: 75.4 });
});

test("each end is clamped independently", () => {
  const s = seg({ lengthM: 100 });
  assert.deepEqual(
    clampCoverageToPassage(profile(10, 80), s, { enteredThrough: true, exitedThrough: false }),
    { coveredFromM: 0, coveredToM: 80 },
  );
  assert.deepEqual(
    clampCoverageToPassage(profile(10, 80), s, { enteredThrough: false, exitedThrough: true }),
    { coveredFromM: 10, coveredToM: 100 },
  );
});

test("nothing proven leaves the measured extent exactly as it was", () => {
  // THE REGRESSION GUARD. A rider who clipped 45m of a 129m footway must still
  // get 45m drawn. That case is why lines are clipped to coverage at all.
  const extent = clampCoverageToPassage(profile(42, 87), seg({ lengthM: 129 }), {
    enteredThrough: false,
    exitedThrough: false,
  });
  assert.deepEqual(extent, { coveredFromM: 42, coveredToM: 87 });
});

test("the clamp never narrows an extent", () => {
  // A run that already reached past its own ends -- the bracketing fixes clamp
  // to 0 and lengthM on a pass-through -- must not be pulled back in.
  const s = seg({ lengthM: 50 });
  const extent = clampCoverageToPassage(profile(0, 50), s, {
    enteredThrough: true,
    exitedThrough: true,
  });
  assert.deepEqual(extent, { coveredFromM: 0, coveredToM: 50 });
});

test("clamping does not mutate the profile it was given", () => {
  const p = profile(3.5, 71);
  clampCoverageToPassage(p, seg({ lengthM: 75.4 }), { enteredThrough: true, exitedThrough: true });
  assert.equal(p.coveredFromM, 3.5);
  assert.equal(p.coveredToM, 71);
});

test("THE REAL CASE: South Weber #18282 backward, 3.5m blank at a mid-block cut", () => {
  // 18283 and 18282 are pieces p1 and p0 of one 150m chunk of way 877505779,
  // so the join between them is an artificial cut with no junction at it. The
  // southbound rider crosses from 18283 into 18282, hysteresis holds the run
  // on 18283 for a fix, and 18282's backward coverage starts 3.5m in. Backward
  // travel 0 is the geometry's end, which is where 18283 sits.
  const p0 = seg({ id: 18282, osmWayId: 877505779, pieceIndex: 0, startNodeId: 55774421, endNodeId: 7300446648, lengthM: 75.4 });
  const p1 = seg({ id: 18283, osmWayId: 877505779, pieceIndex: 1, startNodeId: 55774421, endNodeId: 7300446648, lengthM: 75.4 });
  const ends = buildEndAdjacency([p0, p1]);
  const passage = passageFor("backward", ends.get(18282)!, { segmentId: 18283, gapS: 4 }, null);
  assert.equal(passage.enteredThrough, true);
  const extent = clampCoverageToPassage(profile(3.5, 75.4), p0, passage);
  assert.equal(extent.coveredFromM, 0, "the 3.5m blank closes");
  assert.equal(extent.coveredToM, 75.4);
});
