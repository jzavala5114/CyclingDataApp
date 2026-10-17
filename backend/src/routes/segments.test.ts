import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import pg from "pg";
// Production's driver: pool.ts loads db/pgTypes.ts. The query is faked, but
// every row below is built by that driver's own int8 parser.
import { pool } from "../db/pool.js";
import { segmentsRouter } from "./segments.js";

// GET /segments as the phone receives it, over HTTP and through JSON. The
// join itself is tested in services/segmentsResponse.test.ts; what only this
// file can see is the route around it. A cold review made the route turn every
// segment id into text before the join, the advice often given for sending
// bigints as JSON, and every test passed while the map would have gone blank.

const int8 = (text: string) => pg.types.getTypeParser(pg.types.builtins.INT8, "text")(text) as number;

// One street about 111 m long running north, with buckets at 30, 45 and 60 m
// and a ride that covered 10 to 90 m, as the route's three queries return it.
const segmentRow = {
  id: int8("49704"),
  osmWayId: int8("1234567890"),
  kind: "road",
  streetName: "Gold Camp Road",
  startNodeId: int8("12000000001"),
  endNodeId: int8("12000000002"),
  pieceIndex: 0,
  geom: { type: "LineString", coordinates: [[-104.82, 38.82], [-104.82, 38.821]] },
  lengthM: 111,
  bearingDeg: 0,
};
const bucketRows = [30, 45, 60].map((distanceM, i) => ({
  segmentId: int8("49704"),
  direction: "forward",
  distanceM,
  elevationM: 1900 + i,
  sampleCount: 3,
}));
const coverageRows = [{ segmentId: int8("49704"), direction: "forward", coveredFromM: 10, coveredToM: 90 }];

function fakeDatabase(t: TestContext, rows: { buckets?: unknown[]; passes?: unknown[] } = {}) {
  const parameters: unknown[][] = [];
  t.mock.method(pool, "query", (async (text: string, values: unknown[]) => {
    parameters.push(values);
    if (/from segments s/.test(text)) return { rows: [segmentRow] };
    if (/from segment_elevation_buckets/.test(text)) return { rows: rows.buckets ?? bucketRows };
    if (/from segment_coverage/.test(text)) return { rows: coverageRows };
    if (/from segment_pass_buckets/.test(text)) return { rows: rows.passes ?? [] };
    throw new Error(`unexpected query: ${text}`);
  }) as never);
  return parameters;
}

async function get(pathAndQuery: string) {
  const server = express().use("/segments", segmentsRouter).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`);
    return { status: res.status, body: (await res.json()) as { segments: Record<string, unknown>[] } };
  } finally {
    server.close();
  }
}

test("the driver in this file is production's: ids are numbers", () => {
  assert.equal(typeof segmentRow.id, "number");
  assert.equal(typeof bucketRows[0]!.segmentId, "number");
});

test("GET /segments sends each id as a JSON NUMBER, with the street's line drawn", async (t) => {
  // mobile/src/types/index.ts types SegmentWithGradients.id as `number`.
  fakeDatabase(t);
  const { status, body } = await get("/segments?minLon=-105&minLat=38&maxLon=-104&maxLat=39");
  assert.equal(status, 200);
  assert.equal(body.segments.length, 1);
  const [segment] = body.segments as { id: unknown; directionalLines: { colorStops: unknown[] }[] }[];
  assert.equal(segment!.id, 49704);
  assert.equal(segment!.directionalLines.length, 1, "the street's buckets reached it: the join held");
  assert.ok(segment!.directionalLines[0]!.colorStops.length > 0);
});

test("the bucket, coverage and pass queries are asked for the segments' own ids, as numbers", async (t) => {
  const parameters = fakeDatabase(t);
  await get("/segments?minLon=-105&minLat=38&maxLon=-104&maxLat=39");
  assert.deepEqual(parameters, [[-105, 38, -104, 39], [[49704]], [[49704]], [[49704]]]);
});

test("GET /segments fits the street to its pass rows: a cliff in the means arrives flat", async (t) => {
  // Two flat passes 10 m apart in level, over 30-45 m and 45-60 m. Their means
  // climb 10 m in 30 m, near-black; each pass is flat, green. Ids through the
  // driver, so the route's handling of the fourth query is what is tested.
  const passes = [
    ["9000000001", 30, 1900],
    ["9000000001", 45, 1900],
    ["9000000002", 45, 1910],
    ["9000000002", 60, 1910],
  ].map(([matchId, distanceM, elevationM]) => ({
    segmentId: int8("49704"),
    direction: "forward",
    matchId: int8(matchId as string),
    distanceM,
    elevationM,
  }));
  const buckets = [
    [30, 1900, 1],
    [45, 1905, 2],
    [60, 1910, 1],
  ].map(([distanceM, elevationM, sampleCount]) => ({
    segmentId: int8("49704"),
    direction: "forward",
    distanceM,
    elevationM,
    sampleCount,
  }));
  const colours = async () => {
    const { body } = await get("/segments?minLon=-105&minLat=38&maxLon=-104&maxLat=39");
    const [segment] = body.segments as { directionalLines: { colorStops: { color: string }[] }[] }[];
    return new Set(segment!.directionalLines[0]!.colorStops.map((stop) => stop.color));
  };
  fakeDatabase(t, { buckets });
  assert.deepEqual(await colours(), new Set(["#450a0a"]), "the fixture: without its passes, near-black");
  t.mock.restoreAll();
  fakeDatabase(t, { buckets, passes });
  assert.deepEqual(await colours(), new Set(["#22c55e"]), "with them, green");
});
