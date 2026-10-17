import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDirectionalGradientLines, colorForSlope, pieceSlopesPct } from "./gradientBuilder.js";
import type { Direction, ElevationBucket, PassBucket, Segment } from "../types/index.js";

// The colour bands are the whole of what a rider reads off the map, and every
// edge is a design decision (see SLOPE_STOPS). Each band includes its upper
// edge, so a slope sitting exactly on an edge takes the gentler colour; these
// tests pin every edge from both sides, so moving one, or swapping two colours,
// fails here instead of quietly repainting streets.

const PURPLE = "#7c3aed";
const BLUE = "#2563eb";
const GREEN = "#22c55e";
const YELLOW = "#eab308";
const ORANGE = "#f97316";
const RED = "#dc2626";
const DARK_RED = "#881337";
const NEAR_BLACK_RED = "#450a0a";

test("every band edge belongs to the gentler band, and the next band starts just past it", () => {
  const cases: Array<[number, string]> = [
    [-25, PURPLE],
    [-8, PURPLE],
    [-7.99, BLUE],
    [-3, BLUE],
    [-2.99, GREEN],
    [0, GREEN],
    [0.01, YELLOW],
    [3, YELLOW],
    [3.01, ORANGE],
    [6, ORANGE],
    [6.01, RED],
    [9, RED],
    [9.01, DARK_RED],
    [12, DARK_RED],
    [12.01, NEAR_BLACK_RED],
    [25, NEAR_BLACK_RED],
  ];
  for (const [slopePct, color] of cases) {
    assert.equal(colorForSlope(slopePct), color, `slope ${slopePct}%`);
  }
});

// A straight 75m climb at a constant grade: the least-squares slope of exactly
// linear buckets is that grade, so every piece of the line takes one colour.
const climb = (gradePct: number): ElevationBucket[] =>
  [0, 15, 30, 45, 60, 75].map((distanceM) => ({
    segmentId: 1,
    direction: "forward",
    distanceM,
    elevationM: 1800 + (gradePct / 100) * distanceM,
    sampleCount: 1,
  }));

const segment = {
  id: 1,
  osmWayId: 900,
  kind: "cycleway",
  streetName: "Test Trail",
  startNodeId: 1,
  endNodeId: 2,
  pieceIndex: 0,
  lengthM: 90,
  bearingDeg: 0,
  geom: { type: "LineString", coordinates: [[-104.82, 38.82], [-104.82, 38.8208]] },
} as Segment;

test("the drawn line uses the bands: 7.5% red, 10.5% dark red, 14% and a clamped 40% near-black red", () => {
  for (const [gradePct, color] of [[7.5, RED], [10.5, DARK_RED], [14, NEAR_BLACK_RED], [40, NEAR_BLACK_RED]] as const) {
    const [line] = buildDirectionalGradientLines(segment, { forward: climb(gradePct), backward: [] });
    assert.ok(line.colorStops.length > 0, `${gradePct}% drew no stops`);
    assert.deepEqual(new Set(line.colorStops.map((stop) => stop.color)), new Set([color]), `${gradePct}%`);
  }
});

// ---- each pass's own slope ---------------------------------------------------
//
// The map fits each piece's slope to every pass's own heights wherever all of
// a window's passes are on file, and to the stored means otherwise (slopeFor).
// The means alone drew cliffs where passes at different levels cover different
// stretches of a line, so these hold the per-pass slope to its definition, and
// the fallback to today's slope bit for bit.

// 28974/backward, the footway through the Ridgeway trailhead lot, as the
// replay of rides 54, 81 and 84 measured it (2026-10-16, heights to 0.1 m).
// After each ride's one-offset anchor, ride 54 sits on the terrain, 84 about
// 12 m above it and 81 about 31 m above it, and 84 crossed twice. Every pass
// is close to flat, the terrain climbs 3 m over the 75 m, and the means
// climbed 20 m in 45 m: the map drew it +25%, near-black.
const LOT_PASSES: Array<[matchId: number, distanceM: number, elevationM: number]> = [
  [5401, 60, 1895.5], [5401, 75, 1895.5], [5401, 90, 1896.1],
  [8101, 75, 1926.3], [8101, 90, 1926.1], [8101, 105, 1926.1],
  [8401, 75, 1908.2], [8401, 90, 1907.9],
  [8402, 105, 1905.9], [8402, 120, 1906.6], [8402, 135, 1907.5],
];

const passRows = (rows: Array<[number, number, number]>, direction: Direction = "backward"): PassBucket[] =>
  rows.map(([matchId, distanceM, elevationM]) => ({ segmentId: 28974, direction, matchId, distanceM, elevationM }));

// What mergeBuckets would hold for these passes: each bucket's mean, and how
// many passes went into it.
function meansOf(passes: PassBucket[]): ElevationBucket[] {
  const at = new Map<number, number[]>();
  for (const p of passes) at.set(p.distanceM, [...(at.get(p.distanceM) ?? []), p.elevationM]);
  return [...at]
    .sort((a, b) => a[0] - b[0])
    .map(([distanceM, heights]) => ({
      segmentId: passes[0].segmentId,
      direction: passes[0].direction,
      distanceM,
      elevationM: heights.reduce((s, h) => s + h, 0) / heights.length,
      sampleCount: heights.length,
    }));
}

// An independent least-squares slope, in percent, so the tests do not check
// the builder against itself.
function lsq(points: Array<[distanceM: number, elevationM: number]>): number {
  const n = points.length;
  const md = points.reduce((s, [d]) => s + d, 0) / n;
  const me = points.reduce((s, [, e]) => s + e, 0) / n;
  let cov = 0;
  let variance = 0;
  for (const [d, e] of points) {
    cov += (d - md) * (e - me);
    variance += (d - md) ** 2;
  }
  return (cov / variance) * 100;
}

const clamp25 = (pct: number) => Math.max(-25, Math.min(25, pct));
// The buckets folded into piece i: two before it, and two past the bucket that
// ends it.
const windowOf = <T>(sorted: T[], i: number) => sorted.slice(Math.max(0, i - 2), Math.min(sorted.length - 1, i + 3) + 1);
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);

test("THE LOT: passes at different levels drew a flat footway +25%; each pass's own slope draws it flat", () => {
  const passes = passRows(LOT_PASSES);
  const buckets = meansOf(passes);
  const today = pieceSlopesPct(buckets);
  const after = pieceSlopesPct(buckets, passes);

  assert.equal(today[0], 25, "the means climb 20 m in 45 m, clamped at 25%");
  assert.equal(colorForSlope(today[0]), NEAR_BLACK_RED);
  // Piece 0's window is 60 to 105 m. Ride 54 reads +2.0% over its three
  // buckets, 81 -0.67% over three, 84's first crossing -2.0% over two, and its
  // second covers one bucket of the window, so adds nothing:
  // (2.0 x 3 - 0.67 x 3 - 2.0 x 2) / 8 = 0.
  near(after[0], 0, "piece 0, each pass");
  for (const [i, slope] of after.entries()) {
    assert.ok(Math.abs(slope) <= 6, `piece ${i} draws ${slope.toFixed(1)}%: red or darker on ground the terrain puts at 3 to 6%`);
  }
});

test("with no pass rows every piece is the least-squares slope of its window's means, clamped: today's map", () => {
  const lot = meansOf(passRows(LOT_PASSES));
  for (const buckets of [lot, climb(7.5), climb(40)]) {
    const slopes = pieceSlopesPct(buckets);
    assert.equal(slopes.length, buckets.length - 1, "one slope per gap between buckets");
    for (const [i, slope] of slopes.entries()) {
      near(slope, clamp25(lsq(windowOf(buckets, i).map((b) => [b.distanceM, b.elevationM]))), `piece ${i}`);
    }
  }
});

test("a window short of a bucket's passes is drawn from the means, bit for bit; one with all of them is not", () => {
  // Ride 84's second crossing loses its row at 120 m, as a ride merged before
  // the rows were kept would have none: the bucket's mean still holds it.
  const passes = passRows(LOT_PASSES);
  const buckets = meansOf(passes);
  const short = passes.filter((p) => !(p.matchId === 8402 && p.distanceM === 120));
  const today = pieceSlopesPct(buckets);
  const after = pieceSlopesPct(buckets, short);
  for (const [i, slope] of after.entries()) {
    if (windowOf(buckets, i).some((b) => b.distanceM === 120)) {
      assert.equal(slope, today[i], `piece ${i} holds the 120 m bucket, so it is drawn from the means`);
    }
  }
  near(after[0], 0, "piece 0's window, 60 to 105 m, has every pass on file");
});

test("pass rows beyond a bucket's pass count are not trusted either: the window is drawn from the means", () => {
  // More rows than the mean holds passes: the model's buckets were cleared
  // and refilled without their match rows. The rows describe passes the means
  // no longer hold, so fitting them would draw a model that is not there.
  const passes = passRows(LOT_PASSES);
  const buckets = meansOf(passes).map((b) => (b.distanceM === 90 ? { ...b, sampleCount: b.sampleCount - 1 } : b));
  assert.deepEqual(pieceSlopesPct(buckets, passes), pieceSlopesPct(buckets), "every window holds the 90 m bucket");
});

test("one pass draws exactly the slope of its own heights, which are the means", () => {
  const wobble = [0, 0.3, -0.2, 0.5, 0.1, -0.4];
  const passes = passRows([0, 15, 30, 45, 60, 75].map((d, i) => [700, d, 1850 + 0.04 * d + wobble[i]]));
  const buckets = meansOf(passes);
  const today = pieceSlopesPct(buckets);
  for (const [i, slope] of pieceSlopesPct(buckets, passes).entries()) near(slope, today[i], `piece ${i}`);
});

test("passes over the same buckets at different levels draw the slope of their means: least squares is linear", () => {
  const wobble = [0, 0.3, -0.2, 0.5, 0.1, -0.4];
  const passes = [
    [701, 0, 0],
    [702, 8, 0.3],
    [703, -5, -0.6],
  ].flatMap(([matchId, levelM, scale]) =>
    passRows([0, 15, 30, 45, 60, 75].map((d, i) => [matchId, d, 1850 + levelM + 0.06 * d + scale * wobble[i]])),
  );
  const buckets = meansOf(passes);
  const today = pieceSlopesPct(buckets);
  for (const [i, slope] of pieceSlopesPct(buckets, passes).entries()) near(slope, today[i], `piece ${i}`);
});

test("a pass covering one bucket of a window adds nothing to its slope", () => {
  // Pass 701 climbs a steady 4%. Pass 702 touched only the 30 m bucket, 10 m
  // above it, which pulls that bucket's mean up 5 m and bends every window.
  const passes = [
    ...passRows([0, 15, 30, 45, 60, 75].map((d) => [701, d, 1850 + 0.04 * d])),
    ...passRows([[702, 30, 1850 + 1.2 + 10]]),
  ];
  const buckets = meansOf(passes);
  assert.ok(pieceSlopesPct(buckets).some((slope) => Math.abs(slope - 4) > 3), "the fixture bends the means");
  for (const [i, slope] of pieceSlopesPct(buckets, passes).entries()) near(slope, 4, `piece ${i}`);
});

test("the clamp comes after the averaging, as it does for the means", () => {
  // Pass 701 climbs 40% over 0 to 45 m; pass 702 falls 10% over 30 to 75 m, 50 m
  // higher, so the means jump and their slope clamps at 25. Piece 2's window
  // holds all six buckets, four of each pass: (40 x 4 - 10 x 4) / 8 = 15%.
  // Clamping each pass first would give (25 x 4 - 10 x 4) / 8 = 7.5%.
  const steepThenFalling = [
    ...passRows([0, 15, 30, 45].map((d) => [701, d, 1800 + 0.4 * d])),
    ...passRows([30, 45, 60, 75].map((d) => [702, d, 1850 - 0.1 * d])),
  ];
  const buckets = meansOf(steepThenFalling);
  assert.equal(pieceSlopesPct(buckets)[2], 25, "the means clamp");
  near(pieceSlopesPct(buckets, steepThenFalling)[2], 15, "piece 2, each pass");

  // Both climbing, at 40% and 30%: 35% on average, which clamps to 25.
  const bothSteep = [
    ...passRows([0, 15, 30, 45].map((d) => [701, d, 1800 + 0.4 * d])),
    ...passRows([30, 45, 60, 75].map((d) => [702, d, 1850 + 0.3 * d])),
  ];
  assert.equal(pieceSlopesPct(meansOf(bothSteep), bothSteep)[2], 25);
});

test("a window where no pass covers two buckets is drawn from the means", () => {
  const passes = passRows([[701, 0, 1850], [702, 15, 1851.5]]);
  const buckets = meansOf(passes);
  assert.deepEqual(pieceSlopesPct(buckets, passes), pieceSlopesPct(buckets));
});

test("each direction's line is fitted to its own direction's passes", () => {
  const lotSegment = {
    ...segment,
    id: 28974,
    lengthM: 150,
    geom: { type: "LineString", coordinates: [[-104.8585, 38.7953], [-104.8585, 38.79665]] },
  } as Segment;
  const passes = passRows(LOT_PASSES);
  const buckets = meansOf(passes);
  const colours = (passesByDirection: Partial<Record<Direction, PassBucket[]>>) =>
    buildDirectionalGradientLines(lotSegment, { forward: [], backward: buckets }, {}, passesByDirection)[0].colorStops.map(
      (stop) => stop.color,
    );
  assert.ok(colours({}).includes(NEAR_BLACK_RED), "drawn from the means, the lot is near-black");
  assert.ok(!colours({ backward: passes }).includes(NEAR_BLACK_RED), "drawn from its passes, it is not");
  assert.deepEqual(colours({ forward: passRows(LOT_PASSES, "forward") }), colours({}), "the other direction's passes are not this line's");
});
