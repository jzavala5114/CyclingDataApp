import { test } from "node:test";
import assert from "node:assert/strict";
import * as turf from "@turf/turf";
import pg from "pg";
// The driver exactly as production configures it, imported by name. The join
// below means something only on the ids that driver delivers.
import "../db/pgTypes.js";
import { segmentsWithLines } from "./segmentsResponse.js";
import type { ElevationBucket, PassBucket, Segment, SegmentCoverage } from "../types/index.js";

const int8 = (text: string) => pg.types.getTypeParser(pg.types.builtins.INT8, "text")(text) as number;

// One street about 111 m long running north, as the three queries in
// routes/segments.ts return it, with every id through the driver's own int8
// parser. Buckets sit at 30, 45 and 60 m; the ride covered 10 to 90 m.
const ID = "49704";
const segment: Segment = {
  id: int8(ID),
  osmWayId: int8("1234567890"),
  kind: "road",
  streetName: "Gold Camp Road",
  startNodeId: int8("12000000001"),
  endNodeId: int8("12000000002"),
  pieceIndex: 0,
  lengthM: 111,
  bearingDeg: 0,
  geom: { type: "LineString", coordinates: [[-104.82, 38.82], [-104.82, 38.821]] },
};
const buckets: ElevationBucket[] = [30, 45, 60].map((distanceM, i) => ({
  segmentId: int8(ID),
  direction: "forward",
  distanceM,
  elevationM: 1900 + i,
  sampleCount: 3,
}));
const coverage: SegmentCoverage[] = [{ segmentId: int8(ID), direction: "forward", coveredFromM: 10, coveredToM: 90 }];

const drawnM = (line: { geometry: GeoJSON.LineString }) =>
  turf.length(turf.lineString(line.geometry.coordinates), { units: "meters" });

test("the driver in this file is production's: ids are numbers", () => {
  assert.equal(typeof segment.id, "number");
});

test("THE JOIN: a segment's buckets and coverage, filed under their own ids, reach its line", () => {
  // A cold review moved the route's bucket lookup onto a text id and every test
  // in the suite still passed. This is the test that was missing.
  const [result] = segmentsWithLines([segment], buckets, coverage);
  assert.equal(result!.id, 49704);
  assert.equal(result!.directionalLines.length, 1, "the bucket lookup hit");
  const [line] = result!.directionalLines;
  assert.equal(line!.direction, "forward");
  assert.ok(line!.colorStops.length > 0, "the line has colour");
  // Drawn over the recorded coverage, 10 to 90 m. Had the coverage lookup
  // missed, the buckets alone would give 22.5 to 67.5 m.
  assert.ok(Math.abs(drawnM(line!) - 80) < 2, `the coverage lookup hit: drawn ${drawnM(line!).toFixed(1)} m`);
});

test("each segment gets only its own buckets, and one with none is sent without a line", () => {
  const other: Segment = { ...segment, id: int8("49705") };
  const result = segmentsWithLines([segment, other], buckets, coverage);
  assert.deepEqual(result.map((s) => [s.id, s.directionalLines.length]), [[49704, 1], [49705, 0]]);
});

// Two flat passes 10 m apart in level, one over 30-45 m and one over 45-60 m,
// as the fourth query returns them. Their means climb 10 m in 30 m, which
// draws near-black; their own slopes are flat, which draws green. A missed
// pass lookup throws nothing and quietly brings the cliff back.
const NEAR_BLACK_RED = "#450a0a";
const GREEN = "#22c55e";
const passes: PassBucket[] = [
  [int8("9000000001"), 30, 1900],
  [int8("9000000001"), 45, 1900],
  [int8("9000000002"), 45, 1910],
  [int8("9000000002"), 60, 1910],
].map(([matchId, distanceM, elevationM]) => ({
  segmentId: int8(ID),
  direction: "forward",
  matchId,
  distanceM,
  elevationM,
}));
const meansOfPasses: ElevationBucket[] = [
  [30, 1900, 1],
  [45, 1905, 2],
  [60, 1910, 1],
].map(([distanceM, elevationM, sampleCount]) => ({
  segmentId: int8(ID),
  direction: "forward",
  distanceM,
  elevationM,
  sampleCount,
}));
const colours = (result: ReturnType<typeof segmentsWithLines>[number]) =>
  new Set(result.directionalLines.flatMap((line) => line.colorStops.map((stop) => stop.color)));

test("THE PASS JOIN: a segment's pass rows, filed under their own ids, reach its slope", () => {
  const [fromMeans] = segmentsWithLines([segment], meansOfPasses, coverage);
  assert.deepEqual(colours(fromMeans!), new Set([NEAR_BLACK_RED]), "the fixture: its means draw a cliff");
  const [fromPasses] = segmentsWithLines([segment], meansOfPasses, coverage, passes);
  assert.deepEqual(colours(fromPasses!), new Set([GREEN]), "the pass lookup hit: drawn from each pass, flat");
});

test("each segment is fitted to its own pass rows only", () => {
  const other: Segment = { ...segment, id: int8("49705") };
  const otherMeans = meansOfPasses.map((b) => ({ ...b, segmentId: int8("49705") }));
  const result = segmentsWithLines([segment, other], [...meansOfPasses, ...otherMeans], [], passes);
  assert.deepEqual(result.map((s) => [s.id, [...colours(s)]]), [[49704, [GREEN]], [49705, [NEAR_BLACK_RED]]]);
});
