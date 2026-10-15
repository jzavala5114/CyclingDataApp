import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDirectionalGradientLines, colorForSlope } from "./gradientBuilder.js";
import type { ElevationBucket, Segment } from "../types/index.js";

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
