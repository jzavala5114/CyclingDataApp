import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as turf from "@turf/turf";
import {
  NAMED_MIN_M,
  STEEPEST_WINDOW_M,
  appendPath,
  bandIndex,
  cutAt,
  formatBand,
  formatDistance,
  formatFeet,
  formatGrade,
  formatRideDate,
  formatRise,
  formatRides,
  fromResponse,
  growingFeature,
  pieceAt,
  pointOnPath,
  prependPath,
  profileAt,
  profileColumns,
  selectionBounds,
  selectionFeatures,
  selectionSegmentIds,
  selectionStats,
} from "./pathSelection.js";
import { BANDS, colorFor, east, makePath } from "./testPaths.js";

// The card's numbers and the map's pieces of a selection. A wrong number here
// is a wrong number on the card with nothing on the phone to contradict it,
// so the expected values are worked by hand from the fixtures, not read back
// from the code.

const close = (actual: number, expected: number, tolerance = 1e-6, what = "value") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected}, got ${actual}`);

const lineLengthM = (coordinates: number[][]) => turf.length(turf.lineString(coordinates), { units: "meters" });

// Two pieces: 60m climbing at 4% (4 spans), then 45m descending at -2%.
const twoPieces = () =>
  makePath([
    { segmentId: 1, lengthM: 60, slopes: [4, 4, 4, 4], streetName: "Ridge Trail" },
    { segmentId: 2, lengthM: 45, slopes: [-2, -2, -2], streetName: "Ladders" },
  ]);

test("appendPath measures the answer from where the selection ends, heights included", () => {
  const first = fromResponse(twoPieces());
  const more = makePath([{ segmentId: 3, lengthM: 30, slopes: [10, 10], rule: "history" }], { reason: "fork", aheadM: 12 });
  const joined = appendPath(first, more);
  assert.equal(joined.pieces.length, 3);
  close(joined.lengthM, 135);
  close(joined.pieces[2]!.atM, 105);
  assert.equal(joined.spans[7]!.piece, 2, "the appended span points at the appended piece");
  // The selection ends 60*0.04 - 45*0.02 = 1.5m up; the answer starts there.
  close(joined.spans[7]!.heightM, 1.5);
  close(joined.spans[8]!.heightM, 1.5 + 1.5);
  assert.equal(joined.stop.reason, "fork");
  close(joined.stop.atM, 135);
  close(joined.stop.aheadM, 12);
});

test("prependPath lifts the selection by what leads into it", () => {
  const selection = fromResponse(twoPieces());
  const before = makePath([{ segmentId: 9, lengthM: 30, slopes: [-5, -5], rule: "connect" }], { reason: "joined" });
  const joined = prependPath(selection, before);
  close(joined.lengthM, 135);
  close(joined.pieces[1]!.atM, 30);
  assert.equal(joined.spans[2]!.piece, 1);
  // The lead-in drops 1.5m, so the old start now sits at -1.5m.
  close(joined.spans[2]!.heightM, -1.5);
  const stats = selectionStats(joined, joined.lengthM);
  close(stats.climbM, 2.4, 1e-9, "climb");
  close(stats.descentM, 1.5 + 0.9, 1e-9, "descent");
  assert.equal(joined.stop.reason, "end", "the selection's own end still stands");
  close(joined.stop.atM, 135);
});

test("cutAt shortens the piece and the span it falls in, and the stop reads cut", () => {
  const selection = fromResponse(twoPieces());
  const cut = cutAt(selection, 70);
  close(cut.lengthM, 70);
  assert.equal(cut.pieces.length, 2);
  close(cut.pieces[1]!.lengthM, 10);
  close(cut.pieces[1]!.toM, 10);
  close(lineLengthM(cut.pieces[1]!.geometry.coordinates), 10, 0.05, "cut geometry");
  assert.equal(cut.spans.length, 5);
  close(cut.spans[4]!.lengthM, 10);
  close(cut.spans[4]!.riseM, -0.2, 1e-9, "a cut span's rise shrinks with it");
  assert.deepEqual(cut.stop, { reason: "cut", atM: 70, aheadM: 0, branches: [] });
});

test("cutAt at a piece boundary keeps whole pieces; past the end it changes nothing", () => {
  const selection = fromResponse(twoPieces());
  const atBoundary = cutAt(selection, 60);
  assert.equal(atBoundary.pieces.length, 1);
  assert.equal(atBoundary.spans.length, 4);
  assert.equal(cutAt(selection, 105), selection);
  assert.equal(cutAt(selection, 500), selection);
  const empty = cutAt(selection, 0);
  assert.equal(empty.pieces.length, 0);
  assert.equal(empty.lengthM, 0);
});

test("pointOnPath gives the line and its travel metres; an end lies on the piece it ends", () => {
  const response = makePath([
    { segmentId: 1, lengthM: 60, slopes: [0], fromM: 40 },
    { segmentId: 2, lengthM: 45, slopes: [0], direction: "backward" },
  ]);
  const selection = fromResponse(response);
  const start = pointOnPath(selection, 0)!;
  assert.equal(start.segmentId, 1);
  close(start.atM, 40);
  const boundary = pointOnPath(selection, 60)!;
  assert.equal(boundary.segmentId, 1, "where two pieces meet, the earlier one");
  close(boundary.atM, 100);
  const inside = pointOnPath(selection, 80)!;
  assert.equal(inside.segmentId, 2);
  assert.equal(inside.direction, "backward");
  close(inside.atM, 20);
  close(inside.lon, east(80)[0], 1e-7, "lon");
  assert.equal(pieceAt(selection, 105), 1);
});

test("the card adds up climb, descent, net, average grade and distance", () => {
  const stats = selectionStats(fromResponse(twoPieces()), 105);
  close(stats.distanceM, 105);
  close(stats.climbM, 2.4, 1e-9, "climb");
  close(stats.descentM, 0.9, 1e-9, "descent");
  close(stats.netM, 1.5, 1e-9, "net");
  close(stats.averageGradePct!, (1.5 / 105) * 100, 1e-9, "average grade");
  assert.deepEqual(stats.streetNames, ["Ridge Trail", "Ladders"]);
});

test("the card counts only what is selected: stats at a cut mid-span", () => {
  const stats = selectionStats(fromResponse(twoPieces()), 70);
  close(stats.distanceM, 70);
  close(stats.climbM, 2.4, 1e-9);
  close(stats.descentM, 0.2, 1e-9);
  close(stats.netM, 2.2, 1e-9);
});

test("band shares count measured ground; unmeasured ground is its own figure", () => {
  const response = makePath([
    { segmentId: 1, lengthM: 30, slopes: [1, 1] },
    { segmentId: 2, lengthM: 20, slopes: [5], source: "none" },
    { segmentId: 3, lengthM: 50, slopes: [-4] },
  ]);
  const stats = selectionStats(fromResponse(response), 100);
  close(stats.noDataM, 20);
  const yellow = stats.bands[3]!;
  assert.equal(yellow.color, "#eab308");
  close(yellow.lengthM, 30);
  close(yellow.share, 0.3);
  close(stats.bands[1]!.share, 0.5, 1e-9, "the -4% blue band");
  close(stats.bands[4]!.lengthM, 0, 1e-9, "the 5% estimate is not counted as measured orange");
  const total = stats.bands.reduce((sum, b) => sum + b.share, 0) + stats.noDataM / stats.distanceM;
  close(total, 1, 1e-9, "shares and no data make the whole");
  assert.deepEqual(
    stats.bands.map((b) => [b.minSlopePct, b.maxSlopePct]),
    [[null, -8], [-8, -3], [-3, 0], [0, 3], [3, 6], [6, 9], [9, 12], [12, null]],
  );
});

test("rides run from the fewest to the most behind any measured piece, and the last ride is the latest", () => {
  const response = makePath([
    { segmentId: 1, lengthM: 30, slopes: [0], rides: 4, lastRiddenAt: "2026-09-05T02:59:57.535Z" },
    { segmentId: 2, lengthM: 30, slopes: [0], source: "none" },
    { segmentId: 3, lengthM: 30, slopes: [0], rides: 9, lastRiddenAt: "2026-10-08T23:41:39.415Z" },
    { segmentId: 4, lengthM: 30, slopes: [0], source: "twin", rides: 2, lastRiddenAt: "2026-08-19T01:22:47.894Z" },
  ]);
  const stats = selectionStats(fromResponse(response), 120);
  assert.deepEqual(stats.rides, { min: 2, max: 9 }, "a piece with no data does not drag the minimum to 0");
  assert.equal(stats.lastRiddenAt, "2026-10-08T23:41:39.415Z");
  assert.equal(selectionStats(fromResponse(makePath([{ segmentId: 1, lengthM: 30, slopes: [0], source: "none" }])), 30).rides, null);
});

test("street names read in order, a repeat collapsed and an unnamed piece skipped", () => {
  const response = makePath([
    { segmentId: 1, lengthM: 40, slopes: [0], streetName: "Ridge Trail" },
    { segmentId: 2, lengthM: 40, slopes: [0], streetName: "Ridge Trail" },
    { segmentId: 3, lengthM: 40, slopes: [0], streetName: null },
    { segmentId: 4, lengthM: 40, slopes: [0], streetName: "Ladders" },
    { segmentId: 5, lengthM: 40, slopes: [0], streetName: "Ridge Trail" },
  ]);
  assert.deepEqual(selectionStats(fromResponse(response), 200).streetNames, ["Ridge Trail", "Ladders", "Ridge Trail"]);
});

test("a street the selection only crosses at a junction stays out of the names", () => {
  // East Cimarron, then a 9m link on South Wahsatch where the ramp meets it:
  // the card read "South Wahsatch Avenue -> East Cimarron Street" on the phone.
  const response = makePath([
    { segmentId: 12554, lengthM: 9, slopes: [0], source: "none", streetName: "South Wahsatch Avenue" },
    { segmentId: 20032, lengthM: 64, slopes: [0], streetName: null },
    { segmentId: 687, lengthM: 60, slopes: [0], streetName: "East Cimarron Street" },
  ]);
  assert.deepEqual(selectionStats(fromResponse(response), 133).streetNames, ["East Cimarron Street"]);
  assert.deepEqual(selectionStats(fromResponse(response), 9).streetNames, ["South Wahsatch Avenue"], "unless nothing else is named");
  assert.equal(NAMED_MIN_M, 20);
});

test("the steepest 100m is found exactly, where a window edge meets a slope change", () => {
  // 0-100m at 2%, 100-150m at 10%, then level. The steepest window is
  // [50, 150]: 50m at 2% and 50m at 10% is 6m in 100m. A window sampled every
  // 15m from 0 would start at 45 or 60 and read 5.9% or 5.6%.
  const response = makePath([
    { segmentId: 1, lengthM: 100, slopes: [2] },
    { segmentId: 2, lengthM: 50, slopes: [10] },
    { segmentId: 3, lengthM: 150, slopes: [0] },
  ]);
  const stats = selectionStats(fromResponse(response), 300);
  close(stats.steepest!.gradePct, 6, 1e-9, "steepest");
  close(stats.steepest!.atM, 50, 1e-9, "where it starts");
  assert.equal(STEEPEST_WINDOW_M, 100);
});

test("the steepest figure can be a descent, and is null under 100m", () => {
  const down = makePath([
    { segmentId: 1, lengthM: 100, slopes: [1] },
    { segmentId: 2, lengthM: 100, slopes: [-9] },
  ]);
  close(selectionStats(fromResponse(down), 200).steepest!.gradePct, -9, 1e-9);
  assert.equal(selectionStats(fromResponse(down), 99).steepest, null);
});

test("a window more than a quarter estimated is not trusted for the steepest figure", () => {
  // A 40m stretch with no data, its slope estimated at 20%, in level ground.
  // Every 100m window over it is at least 40% estimated except those that
  // only clip it, so the figure comes from clipped windows: at most 25m of it.
  const response = makePath([
    { segmentId: 1, lengthM: 150, slopes: [0] },
    { segmentId: 2, lengthM: 40, slopes: [20], source: "none" },
    { segmentId: 3, lengthM: 150, slopes: [0] },
  ]);
  const stats = selectionStats(fromResponse(response), 340);
  close(stats.steepest!.gradePct, 5, 1e-9, "25m of 20% in 100m");
});

test("the profile has one column per slot, each the height and colour at its middle", () => {
  const columns = profileColumns(fromResponse(twoPieces()), 105, 7);
  assert.equal(columns.length, 7);
  // Column 0 sits at 7.5m: 0.3m up; column 6 at 97.5m: 2.4 - 37.5*0.02.
  close(columns[0]!.heightM, 0.3, 1e-9);
  close(columns[6]!.heightM, 2.4 - 0.75, 1e-9);
  assert.equal(columns[0]!.color, colorFor(4));
  assert.equal(columns[6]!.color, colorFor(-2));
  assert.deepEqual(profileColumns(fromResponse(twoPieces()), 0, 7), []);
});

test("map features: one per run of a colour on a piece, each knowing where it starts and ends", () => {
  const response = makePath([
    { segmentId: 1, lengthM: 60, slopes: [1, 2, 5, 5] },
    { segmentId: 2, lengthM: 20, slopes: [1], source: "none" },
  ]);
  const features = selectionFeatures(fromResponse(response));
  assert.deepEqual(
    features.map((f) => [f.properties.piece, f.properties.startM, f.properties.endM, f.properties.color, f.properties.noData]),
    [
      [0, 0, 30, colorFor(1), false],
      [0, 30, 60, colorFor(5), false],
      [1, 60, 80, colorFor(1), true],
    ],
  );
  close(lineLengthM(features[1]!.geometry.coordinates), 30, 0.1, "a run's geometry");
});

test("the growing feature is the run the growth is inside, cut where it has reached", () => {
  const features = selectionFeatures(fromResponse(twoPieces()));
  const growing = growingFeature(features, 75)!;
  assert.equal(growing.properties.piece, 1);
  close(lineLengthM(growing.geometry.coordinates), 15, 0.1);
  assert.equal(growingFeature(features, 60), null, "at a run's end nothing is part grown");
});

test("bounds cover only what is selected", () => {
  const [west, , eastEdge] = selectionBounds(fromResponse(twoPieces()), 60)!;
  close(west, east(0)[0], 1e-9);
  close(eastEdge, east(60)[0], 1e-9);
});

test("the segments a selection runs over, in order, once each", () => {
  const response = makePath([
    { segmentId: 5, lengthM: 10, slopes: [0] },
    { segmentId: 5, lengthM: 10, slopes: [0], source: "none" },
    { segmentId: 7, lengthM: 10, slopes: [0] },
  ]);
  assert.deepEqual(selectionSegmentIds(fromResponse(response)), [5, 7]);
});

test("a span's band is found by its colour, else by its slope", () => {
  assert.equal(bandIndex(BANDS, "#f97316", 0), 4);
  assert.equal(bandIndex(BANDS, "#123456", 4.5), 4);
  assert.equal(bandIndex(BANDS, "#123456", 40), 7);
});

test("distances read in feet below half a mile and in miles from it", () => {
  assert.equal(formatDistance(0), "0 ft");
  assert.equal(formatDistance(103.6), "340 ft");
  assert.equal(formatDistance(804.6), "2,640 ft", "2,639.8 ft is still under half a mile");
  assert.equal(formatDistance(804.7), "0.50 mi", "2,640.1 ft is half a mile");
  assert.equal(formatDistance(4950), "3.08 mi");
});

test("heights, grades, bands, dates and rides read as the card prints them", () => {
  assert.equal(formatFeet(125.6), "412 ft");
  assert.equal(formatFeet(-3), "10 ft");
  // A height from the start, as the profile scrub reads it: signed, and 0 with no sign.
  assert.equal(formatRise(36.6), "+120 ft");
  assert.equal(formatRise(-12.2), "−40 ft");
  assert.equal(formatRise(0.1), "0 ft");
  assert.equal(formatRise(-0.1), "0 ft");
  assert.equal(formatGrade(3.14), "+3.1%");
  assert.equal(formatGrade(-2), "−2.0%");
  assert.equal(formatGrade(-0.04), "0.0%");
  assert.equal(formatBand({ minSlopePct: 0, maxSlopePct: 3 }), "0 to 3%");
  assert.equal(formatBand({ minSlopePct: -8, maxSlopePct: -3 }), "−8 to −3%");
  assert.equal(formatBand({ minSlopePct: null, maxSlopePct: -8 }), "below −8%");
  assert.equal(formatBand({ minSlopePct: 12, maxSlopePct: null }), "over 12%");
  const now = new Date(2026, 9, 17, 12);
  assert.equal(formatRideDate(new Date(2026, 9, 8, 12).toISOString(), now), "Oct 8");
  assert.equal(formatRideDate(new Date(2025, 4, 30, 12).toISOString(), now), "May 30, 2025");
  assert.equal(formatRides({ min: 4, max: 4 }), "built from 4 rides");
  assert.equal(formatRides({ min: 2, max: 9 }), "built from 2 to 9 rides");
  assert.equal(formatRides({ min: 1, max: 1 }), "built from 1 ride");
});

test("the profile at a point: the span it falls in and the height there; nothing for no spans", () => {
  const selection = fromResponse(twoPieces());
  const at = profileAt(selection.spans, 67.5)!;
  assert.equal(at.span.slopePct, -2);
  close(at.heightM, 60 * 0.04 - 7.5 * 0.02);
  assert.equal(profileAt([], 10), null);
});
