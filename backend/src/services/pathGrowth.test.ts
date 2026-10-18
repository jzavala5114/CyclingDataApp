import { test } from "node:test";
import assert from "node:assert/strict";
import * as turf from "@turf/turf";
import { drawLine } from "./gradientBuilder.js";
import {
  buildPathGraph,
  candidatesAt,
  connectPath,
  drawnRanges,
  growPath,
  lineKey,
  MAX_NO_DATA_M,
  pathSpans,
  pickNext,
  turnDeg,
  type Extent,
  type LineData,
  type Transition,
} from "./pathGrowth.js";
import type { Direction, ElevationBucket, Segment } from "../types/index.js";

// Small street layouts drawn in metres east (x) and north (y) of a point in
// Colorado Springs. Two segments touch where they share a node id, as the
// importer makes them, unless a test says otherwise.

const LAT0 = 38.83;
const LON0 = -104.82;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const at = ([x, y]: [number, number]) => [LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT];

function seg(
  id: number,
  points: Array<[number, number]>,
  nodes: [number, number],
  { name = null, way = id, piece = 0 }: { name?: string | null; way?: number; piece?: number } = {},
): Segment {
  const coordinates = points.map(at);
  return {
    id,
    osmWayId: way,
    kind: "cycleway",
    streetName: name,
    startNodeId: nodes[0],
    endNodeId: nodes[1],
    pieceIndex: piece,
    geom: { type: "LineString", coordinates },
    lengthM: turf.length(turf.lineString(coordinates), { units: "meters" }),
    bearingDeg: 0,
  };
}

const F: Direction = "forward";
const B: Direction = "backward";

// Every named line drawn end to end, unless `partial` gives its extent.
function extentsFor(
  segments: Segment[],
  lines: Array<[number, Direction]>,
  partial: Record<string, Extent> = {},
): Map<string, Extent> {
  const byId = new Map(segments.map((s) => [s.id, s]));
  return new Map(
    lines.map(([segmentId, direction]) => {
      const key = lineKey({ segmentId, direction });
      return [key, partial[key] ?? { fromM: 0, toM: byId.get(segmentId)!.lengthM }];
    }),
  );
}

const rode = (sessionId: number, from: [number, Direction], to: [number, Direction]): Transition => ({
  sessionId,
  from: { segmentId: from[0], direction: from[1] },
  to: { segmentId: to[0], direction: to[1] },
});

const route = (pieces: Array<{ segmentId: number; direction: Direction }>) =>
  pieces.map((p) => `${p.segmentId}${p.direction === "forward" ? "f" : "b"}`).join(" ");

// A runs north 100 m into a junction; B carries straight on north, C turns
// right (east), D turns left (west).
const A = seg(1, [[0, 0], [0, 100]], [10, 11], { name: "Ridge Trail" });
const straightOn = seg(2, [[0, 100], [0, 200]], [11, 12]);
const right = seg(3, [[0, 100], [100, 100]], [11, 13]);
const left = seg(4, [[0, 100], [-100, 100]], [11, 14]);

test("turnDeg: straight on is 0, a right angle 90, straight back 180, either way round", () => {
  assert.equal(turnDeg(0, 0), 0);
  assert.equal(turnDeg(350, 10), 20);
  assert.equal(turnDeg(10, 350), 20);
  assert.equal(turnDeg(0, 90), 90);
  assert.equal(turnDeg(0, 270), 90);
  assert.equal(turnDeg(45, 225), 180);
});

test("a single way on is taken, and growth ends where the network does", () => {
  const segments = [A, straightOn];
  const graph = buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [2, F]]), transitions: [] });
  const grown = growPath(graph, { segmentId: 1, direction: F, atM: 0 });
  assert.equal(route(grown.pieces), "1f 2f");
  assert.deepEqual(
    grown.pieces.map((p) => p.rule),
    ["start", "turn"],
  );
  assert.equal(grown.stop.reason, "end");
  assert.ok(Math.abs(grown.lengthM - 200) < 0.5, `length ${grown.lengthM}`);
});

test("a neighbour is entered at its nearer end, so a line digitised the other way is travelled backward", () => {
  const reversed = seg(5, [[0, 200], [0, 100]], [12, 11]); // drawn north to south
  const segments = [A, reversed];
  const graph = buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [5, B]]), transitions: [] });
  const [candidate] = candidatesAt(graph, { segmentId: 1, direction: F });
  assert.equal(candidate!.direction, "backward");
  assert.ok(candidate!.turnDeg < 1, `turn ${candidate!.turnDeg}`);
  assert.equal(candidate!.source, "line");
});

test("the other side of the same street is never a way on: no turning around", () => {
  // A dead end: nothing touches A's far end but A itself.
  const graph = buildPathGraph({ segments: [A], extents: extentsFor([A], [[1, F], [1, B]]), transitions: [] });
  assert.deepEqual(candidatesAt(graph, { segmentId: 1, direction: F }), []);
  assert.equal(growPath(graph, { segmentId: 1, direction: F, atM: 0 }).stop.reason, "end");
});

test("a fork goes the way most rides from this line went, by distinct rides", () => {
  const segments = [A, straightOn, right, left];
  const extents = extentsFor(segments, [[1, F], [2, F], [3, F], [4, F]]);
  const transitions = [
    rode(70, [1, F], [3, F]),
    rode(71, [1, F], [3, F]),
    rode(72, [1, F], [2, F]),
    // One ride going right twice is still one ride.
    rode(72, [1, F], [4, F]),
    rode(72, [1, F], [4, F]),
  ];
  const graph = buildPathGraph({ segments, extents, transitions });
  const grown = growPath(graph, { segmentId: 1, direction: F, atM: 0 });
  assert.equal(route(grown.pieces), "1f 3f");
  assert.equal(grown.pieces[1]!.rule, "history");
});

test("a tie in the history decides nothing: the same street name does", () => {
  const namedLeft = seg(4, [[0, 100], [-100, 100]], [11, 14], { name: " ridge  trail" });
  const segments = [A, straightOn, namedLeft];
  const extents = extentsFor(segments, [[1, F], [2, F], [4, F]]);
  const transitions = [rode(70, [1, F], [2, F]), rode(71, [1, F], [4, F])];
  const graph = buildPathGraph({ segments, extents, transitions });
  const picked = pickNext(graph, { segmentId: 1, direction: F }, candidatesAt(graph, { segmentId: 1, direction: F }));
  assert.equal(picked!.candidate.segmentId, 4);
  assert.equal(picked!.rule, "name");
});

test("leaving a ride's own transitions out takes away the history it alone made", () => {
  const segments = [A, straightOn, right];
  const extents = extentsFor(segments, [[1, F], [2, F], [3, F]]);
  const graph = buildPathGraph({ segments, extents, transitions: [rode(70, [1, F], [3, F])] });
  const candidates = candidatesAt(graph, { segmentId: 1, direction: F });
  assert.equal(pickNext(graph, { segmentId: 1, direction: F }, candidates)!.rule, "history");
  // Without ride 70 there is no history, A's name continues nowhere, and the
  // straight branch is the gentle one.
  const without = pickNext(graph, { segmentId: 1, direction: F }, candidates, { excludeSession: 70 })!;
  assert.equal(without.rule, "turn");
  assert.equal(without.candidate.segmentId, 2);
});

test("with no history and no shared name, the gentlest branch within 60 degrees, measured ground first", () => {
  const slight = seg(6, [[0, 100], [30, 200]], [11, 16]); // about 17 degrees right
  const segments = [A, slight, right];
  // The drawn branch is a right angle, past the limit, so the gentle branch
  // with no data is taken.
  let graph = buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [3, F]]), transitions: [] });
  let picked = pickNext(graph, { segmentId: 1, direction: F }, candidatesAt(graph, { segmentId: 1, direction: F }))!;
  assert.equal(picked.candidate.segmentId, 6);
  assert.equal(picked.rule, "turn");
  // Both within the limit: the one with data goes first, though it bends more.
  const drawnSlight = seg(7, [[0, 100], [55, 190]], [11, 17]); // about 31 degrees
  graph = buildPathGraph({
    segments: [A, slight, drawnSlight],
    extents: extentsFor([A, slight, drawnSlight], [[1, F], [7, F]]),
    transitions: [],
  });
  picked = pickNext(graph, { segmentId: 1, direction: F }, candidatesAt(graph, { segmentId: 1, direction: F }))!;
  assert.equal(picked.candidate.segmentId, 7);
});

test("a fork no rule calls stops growth there, offering its branches", () => {
  const segments = [A, right, left];
  const graph = buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [3, F], [4, F]]), transitions: [] });
  const grown = growPath(graph, { segmentId: 1, direction: F, atM: 0 });
  assert.equal(route(grown.pieces), "1f");
  assert.equal(grown.stop.reason, "fork");
  assert.deepEqual(grown.stop.branches.map((b) => b.segmentId), [3, 4]);
});

test("one way on is taken however sharply it bends: a switchback", () => {
  const hairpin = seg(8, [[0, 100], [10, 0]], [11, 18]);
  const segments = [A, hairpin];
  const graph = buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [8, F]]), transitions: [] });
  const grown = growPath(graph, { segmentId: 1, direction: F, atM: 0 });
  assert.equal(route(grown.pieces), "1f 8f");
  assert.equal(grown.pieces[1]!.rule, "only");
});

test("coming back to a segment already in the path stops growth: the loop closes", () => {
  // A north, then east, then back south-west to A's start.
  const east = seg(9, [[0, 100], [100, 100]], [11, 19]);
  const back = seg(10, [[100, 100], [0, 0]], [19, 10]);
  const segments = [A, east, back];
  const graph = buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [9, F], [10, F]]), transitions: [] });
  const grown = growPath(graph, { segmentId: 1, direction: F, atM: 0 });
  assert.equal(route(grown.pieces), "1f 9f 10f");
  assert.equal(grown.stop.reason, "loop");
});

test("ends 3 m apart with no shared node are joined at the 5 m snap, and not without it", () => {
  const near = seg(11, [[3, 100], [3, 200]], [99, 98]); // starts 3 m east of A's end
  const segments = [A, near];
  const extents = extentsFor(segments, [[1, F], [11, F]]);
  const snapped = growPath(buildPathGraph({ segments, extents, transitions: [] }), { segmentId: 1, direction: F, atM: 0 });
  assert.equal(route(snapped.pieces), "1f 11f");
  const unsnapped = growPath(buildPathGraph({ segments, extents, transitions: [], snapM: 0 }), {
    segmentId: 1,
    direction: F,
    atM: 0,
  });
  assert.equal(route(unsnapped.pieces), "1f");
  assert.equal(unsnapped.stop.reason, "end");
});

test("the slices of a capped run follow each other by piece_index, not by the run's end nodes", () => {
  // One OSM way cut into three slices, all carrying the run's end nodes 20 and
  // 21, and a cross street at node 21: only the last slice reaches it.
  const slice = (id: number, piece: number, y0: number) =>
    seg(id, [[0, y0], [0, y0 + 150]], [20, 21], { way: 500, piece });
  const s0 = slice(20, 0, 0);
  const s1 = slice(21, 1, 150);
  const s2 = slice(22, 2, 300);
  const cross = seg(23, [[0, 450], [100, 450]], [21, 24]);
  const segments = [s0, s1, s2, cross];
  const graph = buildPathGraph({
    segments,
    extents: extentsFor(segments, [[20, F], [21, F], [22, F], [23, F]]),
    transitions: [],
  });
  const grown = growPath(graph, { segmentId: 20, direction: F, atM: 0 });
  assert.equal(route(grown.pieces.filter((p) => p.rule !== null)), "20f 21f 22f 23f");
});

test("growth crosses up to 150 m with no data, and stops at the start of a longer stretch", () => {
  const hole = seg(12, [[0, 100], [0, 200]], [11, 12]); // 100 m, no data
  const after = seg(13, [[0, 200], [0, 300]], [12, 13]);
  let segments = [A, hole, after];
  let grown = growPath(
    buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [13, F]]), transitions: [] }),
    { segmentId: 1, direction: F, atM: 0 },
  );
  assert.equal(route(grown.pieces), "1f 12f 13f");
  assert.deepEqual(grown.pieces.map((p) => p.source), ["line", "none", "line"]);

  const longHole = seg(12, [[0, 100], [0, 100 + MAX_NO_DATA_M + 10]], [11, 12]);
  const afterLong = seg(13, [[0, 100 + MAX_NO_DATA_M + 10], [0, 400]], [12, 13]);
  segments = [A, longHole, afterLong];
  grown = growPath(
    buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [13, F]]), transitions: [] }),
    { segmentId: 1, direction: F, atM: 0 },
  );
  assert.equal(route(grown.pieces), "1f");
  assert.equal(grown.stop.reason, "gap");
});

test("a selection never ends on ground nobody measured: a dead end with no data is trimmed", () => {
  const segments = [A, straightOn];
  const grown = growPath(
    buildPathGraph({ segments, extents: extentsFor(segments, [[1, F]]), transitions: [] }),
    { segmentId: 1, direction: F, atM: 0 },
  );
  assert.equal(route(grown.pieces), "1f");
  assert.equal(grown.stop.reason, "gap");
  assert.ok(Math.abs(grown.lengthM - 100) < 0.5);
});

test("a partly drawn line splits into its ground with data and without, and the other direction's data counts", () => {
  const segments = [A, straightOn];
  const extents = extentsFor(segments, [[1, F], [2, F], [2, B]], {
    [lineKey({ segmentId: 2, direction: F })]: { fromM: 30, toM: 70 },
    // Ridden southward over its northern 20 m only: travel 0-20 that way is
    // 80-100 northward.
    [lineKey({ segmentId: 2, direction: B })]: { fromM: 0, toM: 20 },
  });
  const grown = growPath(buildPathGraph({ segments, extents, transitions: [] }), {
    segmentId: 1,
    direction: F,
    atM: 0,
  });
  const onTwo = grown.pieces.filter((p) => p.segmentId === 2);
  assert.deepEqual(
    onTwo.map((p) => [p.source, Math.round(p.fromM), Math.round(p.toM)]),
    [
      ["none", 0, 30],
      ["line", 30, 70],
      ["none", 70, 80],
      ["twin", 80, 100],
    ],
  );
  // Each piece starts where the last ended, along the path.
  for (let i = 1; i < grown.pieces.length; i++) {
    const before = grown.pieces[i - 1]!;
    assert.ok(Math.abs(grown.pieces[i]!.atM - (before.atM + before.toM - before.fromM)) < 1e-9);
  }
});

test("the length limit cuts mid-piece, and an undecidable junction stops growth too", () => {
  const segments = [A, straightOn];
  const extents = extentsFor(segments, [[1, F], [2, F]]);
  let grown = growPath(buildPathGraph({ segments, extents, transitions: [] }), { segmentId: 1, direction: F, atM: 0 }, { maxM: 150 });
  assert.equal(grown.stop.reason, "limit");
  assert.ok(Math.abs(grown.lengthM - 150) < 1e-9);
  grown = growPath(buildPathGraph({ segments, extents, transitions: [], decidable: () => false }), {
    segmentId: 1,
    direction: F,
    atM: 0,
  });
  assert.equal(route(grown.pieces), "1f");
  assert.equal(grown.stop.reason, "limit");
});

// Buckets every 15 m along a line in its direction of travel, at heights
// `height(travel metres)`, drawn the way the map draws them.
function lineData(segment: Segment, direction: Direction, height: (m: number) => number): LineData {
  const buckets: ElevationBucket[] = [];
  for (let d = 0; d <= segment.lengthM + 1e-9; d += 15) {
    buckets.push({ segmentId: segment.id, direction, distanceM: d, elevationM: height(d), sampleCount: 1 });
  }
  const coverage = { segmentId: segment.id, direction, coveredFromM: 0, coveredToM: segment.lengthM };
  return { drawing: drawLine(segment, direction, buckets, coverage)!, buckets };
}

test("a drawing's ranges tile its extent and carry the colours the map draws, both directions", () => {
  for (const direction of [F, B]) {
    const data = lineData(straightOn, direction, (m) => 1900 + (m < 50 ? 0 : (m - 50) * 0.08));
    const ranges = drawnRanges(data.drawing);
    assert.ok(Math.abs(ranges[0]!.fromM - data.drawing.fromTravelM) < 1e-9);
    assert.ok(Math.abs(ranges.at(-1)!.toM - data.drawing.toTravelM) < 1e-9);
    for (let i = 1; i < ranges.length; i++) assert.ok(Math.abs(ranges[i]!.fromM - ranges[i - 1]!.toM) < 1e-9);
    assert.deepEqual(
      new Set(ranges.map((r) => r.color)),
      new Set(data.drawing.stops.map((s) => s.color)),
    );
  }
});

test("the profile follows each line's own slopes: a level step between two lines draws no cliff", () => {
  // Both lines dead flat, the second 3 m higher: two rides at different levels.
  const segments = [A, straightOn];
  const lines = new Map([
    [lineKey({ segmentId: 1, direction: F }), lineData(A, F, () => 1900)],
    [lineKey({ segmentId: 2, direction: F }), lineData(straightOn, F, () => 1903)],
  ]);
  const graph = buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [2, F]]), transitions: [] });
  const grown = growPath(graph, { segmentId: 1, direction: F, atM: 0 });
  const spans = pathSpans(graph, grown.pieces, lines);
  assert.ok(spans.every((s) => s.slopePct === 0), JSON.stringify(spans.map((s) => s.slopePct)));
  const total = spans.reduce((sum, s) => sum + s.lengthM, 0);
  assert.ok(Math.abs(total - grown.lengthM) < 1e-6, "the spans tile the path");
});

test("ground ridden only the other way reads that direction's slope, negated", () => {
  const segments = [A, straightOn];
  // Line 2 ridden southward, climbing 6% that way, so northward it falls 6%.
  const lines = new Map([
    [lineKey({ segmentId: 1, direction: F }), lineData(A, F, () => 1900)],
    [lineKey({ segmentId: 2, direction: B }), lineData(straightOn, B, (m) => 1900 + m * 0.06)],
  ]);
  const graph = buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [2, B]]), transitions: [] });
  const grown = growPath(graph, { segmentId: 1, direction: F, atM: 0 });
  assert.deepEqual(grown.pieces.map((p) => p.source), ["line", "twin"]);
  const twinSpans = pathSpans(graph, grown.pieces, lines).filter((s) => s.source === "twin");
  assert.ok(twinSpans.length > 0);
  for (const s of twinSpans) assert.ok(Math.abs(s.slopePct + 6) < 1e-6, `slope ${s.slopePct}`);
});

test("a stretch with no data gets one slope, estimated from the heights at its two ends", () => {
  const hole = seg(12, [[0, 100], [0, 200]], [11, 12]);
  const after = seg(13, [[0, 200], [0, 300]], [12, 13]);
  const segments = [A, hole, after];
  const lines = new Map([
    [lineKey({ segmentId: 1, direction: F }), lineData(A, F, () => 1900)],
    [lineKey({ segmentId: 13, direction: F }), lineData(after, F, () => 1905)],
  ]);
  const graph = buildPathGraph({ segments, extents: extentsFor(segments, [[1, F], [13, F]]), transitions: [] });
  const grown = growPath(graph, { segmentId: 1, direction: F, atM: 0 });
  const none = pathSpans(graph, grown.pieces, lines).filter((s) => s.source === "none");
  assert.equal(none.length, 1);
  assert.ok(Math.abs(none[0]!.slopePct - 5) < 0.05, `slope ${none[0]!.slopePct}`);
});

test("connectPath: the cheapest way to a held line, preferring measured ground, within the limit", () => {
  // From A, two ways to reach `target`'s start: a measured detour east, north
  // and back west (300 m), or straight on with no data (200 m). A metre with no
  // data costs two, so the detour is cheaper: 300 against 400.
  const north = seg(2, [[0, 100], [0, 300]], [11, 30]);
  const east = seg(3, [[0, 100], [50, 100]], [11, 31]);
  const up = seg(31, [[50, 100], [50, 300]], [31, 32]);
  const over = seg(32, [[50, 300], [0, 300]], [32, 30]);
  const target = seg(33, [[0, 300], [0, 400]], [30, 33]);
  const segments = [A, north, east, up, over, target];
  const graph = buildPathGraph({
    segments,
    extents: extentsFor(segments, [[1, F], [3, F], [31, F], [32, F], [33, F]]),
    transitions: [],
  });
  const pieces = connectPath(graph, { segmentId: 1, direction: F, atM: 50 }, { segmentId: 33, direction: F, atM: 20 })!;
  assert.equal(route(pieces.filter((p) => p.rule !== null)), "1f 3f 31f 32f 33f");
  assert.ok(pieces.every((p) => p.rule === null || p.rule === "connect"));
  assert.ok(Math.abs(pieces[0]!.fromM - 50) < 1e-9);
  assert.ok(Math.abs(pieces.at(-1)!.toM - 20) < 1e-9);
  // Out of reach within 200 m of path: no connection.
  assert.equal(connectPath(graph, { segmentId: 1, direction: F, atM: 50 }, { segmentId: 33, direction: F, atM: 20 }, 200), null);
  // Further along the same line: straight there.
  assert.equal(
    route(connectPath(graph, { segmentId: 1, direction: F, atM: 10 }, { segmentId: 1, direction: F, atM: 90 })!),
    "1f",
  );
  // Behind on the same line, with no way round: none.
  assert.equal(connectPath(graph, { segmentId: 1, direction: F, atM: 90 }, { segmentId: 1, direction: F, atM: 10 }), null);
});
