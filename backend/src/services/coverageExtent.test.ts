import * as turf from "@turf/turf";
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

// -- endpointSnapM: ends that meet on the ground without sharing a node -------
//
// Measured 2026-10-03: 45 of 47 ride transitions that looked impossible join
// segments whose ends are within 30m and share no node id. Palmer Point Trail
// is the worked case -- one OSM way, 4m apart, no shared node, because OSM maps
// that junction twice.
//
// NOTE on the fixtures: `seg` above gives every segment the SAME default
// geometry, so with snapping switched on every fixture in this file would be a
// neighbour of every other. That is why these tests set geometry explicitly,
// and why the default has to stay off.

// Degrees of latitude per metre on turf's sphere (R = 6371008.8m). Latitude so
// the figure does not depend on longitude convergence.
const DEG_PER_M = 1 / 111_194.93;
const northOf = (lat: number, metres: number) => lat + metres * DEG_PER_M;
const line = (...points: Array<[number, number]>) => ({
  type: "LineString" as const,
  coordinates: points,
});

test("THE CASE THIS EXISTS FOR: ends 4m apart with different nodes are joined when snapping is on", () => {
  // Palmer Point #75376 ends at node 1850877208 and #75377 begins at node
  // 3096809454, 4m away, on the same OSM way.
  const a = seg({
    id: 80, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, northOf(38.8, -50)], [-104.8, 38.8]),
  });
  const b = seg({
    id: 81, startNodeId: 3, endNodeId: 4,
    geom: line([-104.8, northOf(38.8, 4)], [-104.8, northOf(38.8, 54)]),
  });
  const ends = buildEndAdjacency([a, b], 5);
  assert.deepEqual([...ends.get(80)!.end], [81], "a's END meets b");
  assert.deepEqual([...ends.get(81)!.start], [80], "b's START meets a");
  assert.deepEqual([...ends.get(80)!.start], [], "and not at the far ends");
  assert.deepEqual([...ends.get(81)!.end], []);
});

test("NO REGRESSION: the same pair is NOT joined by default, so shipped behaviour is unchanged", () => {
  // The guarantee that this change is inert until a sweep prices it. Asserted
  // against the default call AND against an explicit 0, because the two are
  // different ways of getting the shipped behaviour.
  const a = seg({
    id: 82, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, northOf(38.8, -50)], [-104.8, 38.8]),
  });
  const b = seg({
    id: 83, startNodeId: 3, endNodeId: 4,
    geom: line([-104.8, northOf(38.8, 4)], [-104.8, northOf(38.8, 54)]),
  });
  for (const ends of [buildEndAdjacency([a, b]), buildEndAdjacency([a, b], 0)]) {
    assert.deepEqual([...ends.get(82)!.end], []);
    assert.deepEqual([...ends.get(83)!.start], []);
  }
});

test("BOUNDARY: the radius is respected, so a 4m gap is out of reach at 3m", () => {
  const a = seg({
    id: 84, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, northOf(38.8, -50)], [-104.8, 38.8]),
  });
  const b = seg({
    id: 85, startNodeId: 3, endNodeId: 4,
    geom: line([-104.8, northOf(38.8, 4)], [-104.8, northOf(38.8, 54)]),
  });
  assert.deepEqual([...buildEndAdjacency([a, b], 3).get(84)!.end], [], "4m apart, 3m radius");
  assert.deepEqual([...buildEndAdjacency([a, b], 5).get(84)!.end], [85], "same pair at 5m");
});

test("THE ONE THAT PREVENTS INVENTED PAINT: a middle slice gets no proximity neighbour either", () => {
  // The safety property, and it is about the coverage clamp rather than the
  // matcher. A middle slice's geometric end is an arbitrary 150m cut with
  // nothing at it. Node identity already refuses to attach a cross street
  // there; proximity must refuse too, or the clamp paints to a join the rider
  // never crossed -- from the wrong end of the slice.
  //
  // The cross street here sits EXACTLY on the cut, 0m away, which is the
  // hardest version of the case.
  const cut = 38.8;
  const p0 = seg({
    id: 90, pieceIndex: 0, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, northOf(cut, -100)], [-104.8, cut]),
  });
  const p1 = seg({
    id: 91, pieceIndex: 1, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, cut], [-104.8, northOf(cut, 100)]),
  });
  const p2 = seg({
    id: 92, pieceIndex: 2, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, northOf(cut, 100)], [-104.8, northOf(cut, 200)]),
  });
  const crossAtTheCut = seg({
    id: 93, osmWayId: 901, startNodeId: 8, endNodeId: 9,
    geom: line([-104.8, cut], [-104.7995, cut]),
  });
  const ends = buildEndAdjacency([p0, p1, p2, crossAtTheCut], 5);

  assert.equal(ends.get(91)!.start.has(93), false, "the cut is not a junction");
  assert.equal(ends.get(90)!.end.has(93), false, "nor from the other side of it");
  assert.equal(ends.get(93)!.start.has(91), false, "and the cross street agrees");
  assert.equal(ends.get(93)!.start.has(90), false);
  // The siblings still meet by piece order, which proximity must not disturb.
  assert.deepEqual([...ends.get(91)!.start], [90]);
  assert.deepEqual([...ends.get(91)!.end], [92]);
});

test("the LAST slice's far end is a real node, so it can snap", () => {
  // The other half of the rule above: suppression applies to cuts, not to the
  // run's genuine ends, or the repair would never fire on a sliced trail.
  const p0 = seg({
    id: 94, pieceIndex: 0, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, northOf(38.8, -100)], [-104.8, 38.8]),
  });
  const p1 = seg({
    id: 95, pieceIndex: 1, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, 38.8], [-104.8, northOf(38.8, 100)]),
  });
  const nearby = seg({
    id: 96, osmWayId: 901, startNodeId: 8, endNodeId: 9,
    geom: line([-104.8, northOf(38.8, 104)], [-104.7995, northOf(38.8, 104)]),
  });
  const ends = buildEndAdjacency([p0, p1, nearby], 5);
  assert.ok(ends.get(95)!.end.has(96), "piece 1 of 2 owns the run's end node");
  assert.ok(ends.get(96)!.start.has(95));
});

test("a segment whose own two ends are close is not its own neighbour", () => {
  // A tiny loop is not a junction with anything.
  const loop = seg({
    id: 97, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, 38.8], [-104.8005, northOf(38.8, 30)], [-104.8, northOf(38.8, 4)]),
  });
  const ends = buildEndAdjacency([loop], 5);
  assert.deepEqual([...ends.get(97)!.start], []);
  assert.deepEqual([...ends.get(97)!.end], []);
});

test("snapping does not disturb a pair that already shares a node", () => {
  const a = seg({ id: 98, startNodeId: 1, endNodeId: 2, geom: line([-104.8, 38.8], [-104.8, northOf(38.8, 50)]) });
  const b = seg({ id: 99, osmWayId: 901, startNodeId: 2, endNodeId: 3, geom: line([-104.7, 38.7], [-104.7, northOf(38.7, 50)]) });
  const ends = buildEndAdjacency([a, b], 5);
  assert.deepEqual([...ends.get(98)!.end], [99]);
  assert.deepEqual([...ends.get(99)!.start], [98]);
});

test("NaN geometry joins nothing, because the grid key isolates it", () => {
  // Worth being precise about the mechanism, because the obvious reading is
  // wrong. A NaN corner's cell key is `NaN|NaN`, which no finite cell lookup
  // ever asks for, so the pair is never even compared -- the distance test is
  // not what saves this case, and a mutation of the distance test leaves this
  // assertion green.
  const a = seg({
    id: 100, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, northOf(38.8, -50)], [-104.8, 38.8]),
  });
  const broken = seg({
    id: 101, startNodeId: 3, endNodeId: 4,
    geom: line([Number.NaN, Number.NaN], [-104.8, northOf(38.8, 54)]),
  });
  const ends = buildEndAdjacency([a, broken], 5);
  assert.deepEqual([...ends.get(100)!.end], []);
  assert.deepEqual([...ends.get(101)!.start], []);
});

test("THE REJECTION BOUND: two Infinity corners share a cell and must not be joined", () => {
  // This is the case that actually reaches the distance comparison with a
  // non-finite result. `Math.floor(Infinity / cell)` is Infinity for both, so
  // the two corners land in the SAME cell and are compared; turf returns NaN.
  // `apart > endpointSnapM` is false for NaN, so a rejection bound would invent
  // an edge out of corrupt geometry, and the clamp would turn it into paint.
  // Hence `!(apart <= endpointSnapM)`.
  //
  // Verified by mutation: switching the bound back makes this fail.
  const a = seg({
    id: 102, startNodeId: 1, endNodeId: 2,
    geom: line([-104.8, 38.8], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]),
  });
  const b = seg({
    id: 103, startNodeId: 3, endNodeId: 4,
    geom: line([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY], [-104.7, 38.7]),
  });
  const ends = buildEndAdjacency([a, b], 5);
  assert.deepEqual([...ends.get(102)!.end], [], "an unmeasurable distance is not within 5m");
  assert.deepEqual([...ends.get(103)!.start], []);
});

// -- the grid, on both axes ---------------------------------------------------
//
// A bucketed lookup misses a pair that straddles a cell boundary unless the
// cell is at least the radius wide in BOTH axes and the neighbourhood is 3x3.
// Longitude is the tighter axis, and the first version of the implementation
// sized cells at `snap / 86_680` degrees, which is under the radius wherever
// cos(latitude) < 0.779 -- i.e. north of 38.8N, which is most of this network.
// The north-south fuzz below could never catch that, so the east-west one is
// not a duplicate of it.
const EAST_WEST_LAT = 38.97; // the northern edge of the segment table

// Placed with turf rather than by hand, because the gap below has only
// millimetres of margin under the radius. The first version computed the
// longitude offset as `metres / (111194.93 * cos(lat))`, and that approximation
// is wrong by a few millimetres against the haversine distance the matcher
// actually measures -- enough to push some pairs genuinely past 5m, where they
// were then CORRECTLY rejected. The test was measuring its own fixture error.
const eastPoint = (lon: number, lat: number, metres: number): [number, number] =>
  turf.destination([lon, lat], metres, 90, { units: "meters" }).geometry.coordinates as [
    number,
    number,
  ];

let fuzzSeed = 20261003;
const rand = () => ((fuzzSeed = (fuzzSeed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

test("FUZZ north-south: a 4m gap is found wherever it falls", () => {
  let missed = 0;
  for (let i = 0; i < 500; i++) {
    const lon = -105 + rand() * 0.5;
    const lat = 38.6 + rand() * 0.5;
    const a = seg({
      id: 1000 + i * 2, startNodeId: 1, endNodeId: 2,
      geom: line([lon, northOf(lat, -50)], [lon, lat]),
    });
    const b = seg({
      id: 1001 + i * 2, startNodeId: 3, endNodeId: 4,
      geom: line([lon, northOf(lat, 4)], [lon, northOf(lat, 54)]),
    });
    if (!buildEndAdjacency([a, b], 5).get(a.id)!.end.has(b.id)) missed++;
  }
  assert.equal(missed, 0, `${missed} of 500 north-south pairs were not joined`);
});

test("SWEEP east-west at 38.97N: the axis and the gap the cell size was wrong on", () => {
  // Deterministic, not random, because the window this has to hit is 13mm wide.
  //
  // At the old `snap / 86_680` the cell is 4.9868m wide in longitude at this
  // latitude, so a pair further apart than that can sit TWO cells apart and the
  // 3x3 lookup misses it. The failing gap window is therefore
  // (4.9868m, 5.0m] -- and the first version of this test used 4.9m, which is
  // INSIDE the cell and could never miss however many random positions it tried.
  //
  // 4.995m is inside the window. Stepping the longitude across more than one
  // cell width guarantees that some step straddles a boundary, so this fails
  // every time against the bad divisor rather than only when it gets unlucky.
  const lat = EAST_WEST_LAT;
  const gapM = 4.99; // inside the bad cell's failing window, 10mm under the radius
  // The step must be FINER than the failing band, or the sweep walks straight
  // over it. The first version used 400 steps across 14m -- 35mm steps against
  // an 8mm band -- and the mutant survived. 6000 steps across 8m is 1.3mm.
  const STEPS = 6000;
  const spanM = 8;
  let missed = 0;
  for (let i = 0; i < STEPS; i++) {
    const [lon] = eastPoint(-104.9, lat, (i / STEPS) * spanM);
    const a = seg({
      id: 3000 + i * 2, startNodeId: 1, endNodeId: 2,
      geom: line(eastPoint(lon, lat, -50), [lon, lat]),
    });
    const b = seg({
      id: 3001 + i * 2, startNodeId: 3, endNodeId: 4,
      geom: line(eastPoint(lon, lat, gapM), eastPoint(lon, lat, 54)),
    });
    if (!buildEndAdjacency([a, b], 5).get(a.id)!.end.has(b.id)) missed++;
  }
  assert.equal(
    missed,
    0,
    `${missed} of ${STEPS} east-west pairs ${gapM}m apart at ${lat}N were not joined`,
  );
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
