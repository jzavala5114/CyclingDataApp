import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import pg from "pg";
// Production's driver: pool.ts loads db/pgTypes.ts. The queries are faked, but
// every id below is built by that driver's own int8 parser.
import { pool } from "../db/pool.js";
import { segmentsRouter } from "./segments.js";
import { buildDirectionalGradientLines } from "../services/gradientBuilder.js";
import type { Direction, ElevationBucket, Segment } from "../types/index.js";

// GET /segments/path as the phone receives it, over HTTP and through JSON.
// services/pathGrowth.test.ts tests the growing; this file tests the route
// around it: its parameters, its three kinds of request, and that what it
// sends sits exactly on the lines GET /segments draws.

const int8 = (text: string) => pg.types.getTypeParser(pg.types.builtins.INT8, "text")(text) as number;

// Two pieces of one trail running north, A then B, 111 m each, meeting at node
// 101. A is drawn both ways, B northward only; A climbs 4% northward.
const LON = -104.82;
const segmentA: Segment = {
  id: int8("70001"),
  osmWayId: int8("1234567890"),
  kind: "cycleway",
  streetName: "Ridge Trail",
  startNodeId: int8("12000000100"),
  endNodeId: int8("12000000101"),
  pieceIndex: 0,
  geom: { type: "LineString", coordinates: [[LON, 38.82], [LON, 38.821]] },
  lengthM: 111.2,
  bearingDeg: 0,
};
const segmentB: Segment = {
  ...segmentA,
  id: int8("70002"),
  osmWayId: int8("1234567891"),
  startNodeId: int8("12000000101"),
  endNodeId: int8("12000000102"),
  geom: { type: "LineString", coordinates: [[LON, 38.821], [LON, 38.822]] },
};

function buckets(segment: Segment, direction: Direction, slopePct: number): ElevationBucket[] {
  const rows: ElevationBucket[] = [];
  for (let d = 0; d <= segment.lengthM; d += 15) {
    rows.push({ segmentId: segment.id, direction, distanceM: d, elevationM: 1900 + (d * slopePct) / 100, sampleCount: 2 });
  }
  return rows;
}
const bucketRows = [
  ...buckets(segmentA, "forward", 4),
  ...buckets(segmentA, "backward", -4),
  ...buckets(segmentB, "forward", 4),
];
const fullCoverage = (segment: Segment, direction: Direction) => ({
  segmentId: segment.id,
  direction,
  coveredFromM: 0,
  coveredToM: segment.lengthM,
});

interface Rows {
  segments?: Segment[];
  coverage?: ReturnType<typeof fullCoverage>[];
}

function fakeDatabase(t: TestContext, rows: Rows = {}) {
  const segments = rows.segments ?? [segmentA, segmentB];
  const coverage = rows.coverage ?? [
    fullCoverage(segmentA, "forward"),
    fullCoverage(segmentA, "backward"),
    fullCoverage(segmentB, "forward"),
  ];
  const ids = new Set(segments.map((s) => s.id));
  const drawnBuckets = bucketRows.filter((b) => ids.has(b.segmentId));
  const asked: string[] = [];
  t.mock.method(pool, "query", (async (text: string) => {
    if (/with drawn as/.test(text)) return asked.push("segments"), { rows: segments };
    if (/lead\(m\.segment_id\)/.test(text)) return asked.push("transitions"), { rows: [] };
    if (/min\(b\.distance_m\)/.test(text)) {
      asked.push("extents");
      const lines = new Map<string, { segmentId: number; direction: Direction; first: number; last: number }>();
      for (const b of drawnBuckets) {
        const key = `${b.segmentId}:${b.direction}`;
        const line = lines.get(key) ?? { segmentId: b.segmentId, direction: b.direction, first: Infinity, last: -Infinity };
        line.first = Math.min(line.first, b.distanceM);
        line.last = Math.max(line.last, b.distanceM);
        lines.set(key, line);
      }
      return {
        rows: [...lines.values()].map((l) => {
          const c = coverage.find((x) => x.segmentId === l.segmentId && x.direction === l.direction);
          return {
            segmentId: l.segmentId,
            direction: l.direction,
            firstBucketM: l.first,
            lastBucketM: l.last,
            coveredFromM: c?.coveredFromM ?? null,
            coveredToM: c?.coveredToM ?? null,
          };
        }),
      };
    }
    if (/from segment_elevation_buckets\s+where/.test(text)) return asked.push("buckets"), { rows: drawnBuckets };
    if (/from segment_coverage/.test(text)) return asked.push("coverage"), { rows: coverage };
    if (/from segment_pass_buckets/.test(text)) return asked.push("passes"), { rows: [] };
    if (/count\(distinct m\.session_id\)/.test(text)) {
      asked.push("rides");
      return {
        rows: [
          { segmentId: segmentA.id, direction: "forward", rides: 3, lastRiddenAt: new Date("2026-10-11T15:00:00Z") },
          { segmentId: segmentA.id, direction: "backward", rides: 1, lastRiddenAt: new Date("2026-09-30T15:00:00Z") },
          { segmentId: segmentB.id, direction: "forward", rides: 2, lastRiddenAt: new Date("2026-10-02T15:00:00Z") },
        ],
      };
    }
    throw new Error(`unexpected query: ${text}`);
  }) as never);
  return asked;
}

interface PathBody {
  error?: string;
  pieces: Array<{
    segmentId: unknown;
    direction: Direction;
    fromM: number;
    toM: number;
    atM: number;
    lengthM: number;
    source: string;
    rule: string | null;
    geometry: GeoJSON.LineString;
    rides: number;
    lastRiddenAt: string | null;
  }>;
  spans: Array<{ atM: number; lengthM: number; slopePct: number; color: string; source: string }>;
  lengthM: number;
  stop: { reason: string; atM: number; branches: unknown[] };
  bands: Array<{ maxSlopePct: number | null; color: string }>;
}

async function get(query: Record<string, string | number>) {
  const server = express().use("/segments", segmentsRouter).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`http://127.0.0.1:${port}/segments/path?${params}`);
    return { status: res.status, body: (await res.json()) as PathBody };
  } finally {
    server.close();
  }
}

const near = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

test("a press grows ahead from the pressed point, in numbers the phone can use", async (t) => {
  fakeDatabase(t);
  // Halfway up A, pressed on its northward line.
  const { status, body } = await get({ segmentId: 70001, direction: "forward", lon: LON + 0.00005, lat: 38.8205 });
  assert.equal(status, 200);
  assert.deepEqual(
    body.pieces.map((p) => [p.segmentId, p.direction, p.source, p.rule]),
    [
      [70001, "forward", "line", "start"],
      // No history; B carries on Ridge Trail.
      [70002, "forward", "line", "name"],
    ],
  );
  assert.equal(typeof body.pieces[0]!.segmentId, "number");
  assert.ok(near(body.pieces[0]!.fromM, 55.6, 1), `pressed at ${body.pieces[0]!.fromM} m`);
  assert.ok(near(body.lengthM, 111.2 - body.pieces[0]!.fromM + 111.2, 1e-6));
  assert.equal(body.stop.reason, "end");
  assert.deepEqual(
    body.pieces.map((p) => [p.rides, p.lastRiddenAt]),
    [
      [3, "2026-10-11T15:00:00.000Z"],
      [2, "2026-10-02T15:00:00.000Z"],
    ],
  );
  // Northward travel, drawn on its right: east of the centreline, south to north.
  const coords = body.pieces[0]!.geometry.coordinates;
  assert.ok(coords.every(([lon]) => lon! > LON), "on the east side");
  assert.ok(coords[0]![1]! < coords.at(-1)![1]!, "in the order it is travelled");
  // The spans tile the path and carry A's climb.
  let atM = 0;
  for (const span of body.spans) {
    assert.ok(near(span.atM, atM, 1e-6));
    atM += span.lengthM;
  }
  assert.ok(near(atM, body.lengthM, 1e-6));
  assert.ok(body.spans.every((s) => near(s.slopePct, 4, 1e-6)), JSON.stringify(body.spans.map((s) => s.slopePct)));
  assert.equal(body.bands.at(-1)!.maxSlopePct, null);
});

test("each piece is the map's own line: GET /segments draws exactly that geometry, both directions", async (t) => {
  const map = buildDirectionalGradientLines(
    segmentA,
    { forward: bucketRows.filter((b) => b.segmentId === segmentA.id && b.direction === "forward"),
      backward: bucketRows.filter((b) => b.segmentId === segmentA.id && b.direction === "backward") },
    { forward: fullCoverage(segmentA, "forward"), backward: fullCoverage(segmentA, "backward") },
  );
  for (const direction of ["forward", "backward"] as const) {
    fakeDatabase(t);
    const start = direction === "forward" ? [LON, 38.82] : [LON, 38.821];
    const { body } = await get({ segmentId: 70001, direction, lon: start[0]!, lat: start[1]! });
    const piece = body.pieces[0]!;
    assert.equal(piece.segmentId, 70001);
    assert.ok(near(piece.fromM, 0, 1e-9) && near(piece.toM, segmentA.lengthM, 1e-9), `${piece.fromM}-${piece.toM}`);
    const drawn = map.find((line) => line.direction === direction)!.geometry.coordinates;
    const travelled = direction === "forward" ? drawn : [...drawn].reverse();
    assert.deepEqual(piece.geometry.coordinates, travelled);
  }
});

test("a press beside the drawn stretch is moved onto it", async (t) => {
  fakeDatabase(t, {
    coverage: [
      { ...fullCoverage(segmentA, "forward"), coveredFromM: 20, coveredToM: 90 },
      fullCoverage(segmentA, "backward"),
      fullCoverage(segmentB, "forward"),
    ],
  });
  const { body } = await get({ segmentId: 70001, direction: "forward", lon: LON, lat: 38.82 });
  assert.ok(near(body.pieces[0]!.fromM, 20, 1e-9), `starts at ${body.pieces[0]!.fromM}`);
  assert.equal(body.pieces[0]!.source, "line");
});

test("bad parameters are a 400 naming what is wrong, before anything is asked of the database", async (t) => {
  const asked = fakeDatabase(t);
  const good = { segmentId: 70001, direction: "forward", lon: LON, lat: 38.82 };
  for (const [query, field] of [
    [{ ...good, segmentId: "x" }, "segmentId"],
    [{ ...good, direction: "north" }, "direction"],
    [{ ...good, lat: 91 }, "lat"],
    [{ ...good, toSegmentId: 70002 }, "go together"],
    [{ ...good, grow: "false" }, "needs a point"],
    [{ ...good, avoid: "70002,x" }, "avoid"],
  ] as Array<[Record<string, string | number>, string]>) {
    const { status, body } = await get(query);
    assert.equal(status, 400, JSON.stringify(query));
    assert.match(body.error!, new RegExp(field));
  }
  assert.deepEqual(asked, []);
});

test("a segment the loaded network does not hold is a 404", async (t) => {
  fakeDatabase(t);
  const { status, body } = await get({ segmentId: 79999, direction: "forward", lon: LON, lat: 38.82 });
  assert.equal(status, 404);
  assert.match(body.error!, /79999/);
});

test("a hold past the end connects to the held line, then grows on from it", async (t) => {
  fakeDatabase(t);
  // The selection ends 30 m up A; the rider holds B, 40 m up it.
  const { body } = await get({
    segmentId: 70001,
    direction: "forward",
    lon: LON,
    lat: 38.82027,
    atM: 30,
    toSegmentId: 70002,
    toDirection: "forward",
    toLon: LON + 0.00005,
    toLat: 38.82136,
  });
  assert.deepEqual(
    body.pieces.map((p) => [p.segmentId, p.rule, Math.round(p.fromM), Math.round(p.toM)]),
    [
      [70001, "connect", 30, 111],
      [70002, "connect", 0, 40],
      [70002, null, 40, 111],
    ],
  );
  assert.equal(body.stop.reason, "end");
});

test("a hold behind the start with grow=false joins the selection and stops there", async (t) => {
  fakeDatabase(t);
  const { body } = await get({
    segmentId: 70001,
    direction: "forward",
    lon: LON,
    lat: 38.8201,
    toSegmentId: 70002,
    toDirection: "forward",
    toLon: LON,
    toLat: 38.8214,
    toAtM: 50,
    grow: "false",
  });
  assert.equal(body.stop.reason, "joined");
  assert.ok(near(body.pieces.at(-1)!.toM, 50, 1e-9));
  assert.equal(body.pieces.at(-1)!.segmentId, 70002);
});

test("a point with no way to it is unreachable, an empty path and not an error", async (t) => {
  fakeDatabase(t);
  // From B northward there is no way back onto A.
  const { status, body } = await get({
    segmentId: 70002,
    direction: "forward",
    lon: LON,
    lat: 38.8215,
    toSegmentId: 70001,
    toDirection: "forward",
    toLon: LON,
    toLat: 38.8203,
  });
  assert.equal(status, 200);
  assert.equal(body.stop.reason, "unreachable");
  assert.deepEqual(body.pieces, []);
});

test("growth stops at a segment the selection already holds", async (t) => {
  fakeDatabase(t);
  const { body } = await get({ segmentId: 70001, direction: "forward", lon: LON, lat: 38.82, avoid: "70002" });
  assert.deepEqual(body.pieces.map((p) => p.segmentId), [70001]);
  assert.equal(body.stop.reason, "loop");
});
