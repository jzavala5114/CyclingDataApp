// npm run time:path
//
// Read-only. Times each stage of GET /segments/path's handler against the
// live database from wherever it runs, on a cold pool (every connection
// closed) and a warm one, so a request's time splits into connecting, the
// stages that wait on the database, and the growth in memory. It runs the
// route's own loaders; every statement only reads.
//
// Run from this PC, a round trip to the database costs what `select 1` says
// here. In production it costs the round trip from wherever Railway runs the
// backend: on 2026-10-18 that was Amsterdam, about 150ms from the database in
// Oregon against about 43ms from here, and the stages below are round trips
// and transfer far more than work (EXPLAIN ANALYZE put the database's own
// execution at about 50ms of a 418ms warm request from here).
import "dotenv/config";
import * as turf from "@turf/turf";
import { pool } from "../db/pool.js";
import { boxAround, insideBox, loadExtents, loadLineData, loadPathSegments, loadTransitions } from "../services/pathData.js";
import { buildPathGraph, growPath, lineKey } from "../services/pathGrowth.js";
import { pathResponse } from "../services/pathResponse.js";
import type { Direction, Segment } from "../types/index.js";

// The route's own numbers (src/routes/segments.ts).
const PATH_BOX_M = 2000;
const PATH_EDGE_M = 100;

// Real presses, from the access log and eval:selection: a trail and downtown.
const PRESSES: Array<{ name: string; segmentId: number; direction: Direction; lon: number; lat: number }> = [
  { name: "trails 19475:forward", segmentId: 19475, direction: "forward", lon: -104.87663973610584, lat: 38.801166000803974 },
  { name: "downtown 9270:forward", segmentId: 9270, direction: "forward", lon: -104.81840068792545, lat: 38.82764673638745 },
];

const ms = (t0: number) => performance.now() - t0;
const fmt = (n: number) => `${n.toFixed(0)}ms`;

function travelMAt(segment: Segment, direction: Direction, lonLat: [number, number]): number {
  const line = turf.lineString(segment.geom.coordinates);
  const geometryM = turf.length(line, { units: "meters" });
  const nearest = turf.nearestPointOnLine(line, lonLat, { units: "meters" });
  const forwardM = nearest.properties.totalDistance * (geometryM > 0 ? segment.lengthM / geometryM : 1);
  return direction === "forward" ? forwardM : segment.lengthM - forwardM;
}

// One request, stage by stage, as the route runs it.
async function request(press: (typeof PRESSES)[number]) {
  const stages: Array<[string, number]> = [];
  const t = performance.now();

  let t0 = performance.now();
  const box = boxAround([[press.lon, press.lat]], PATH_BOX_M);
  const [segments, transitions] = await Promise.all([loadPathSegments(pool, box), loadTransitions(pool)]);
  stages.push(["network + ride order", ms(t0)]);

  t0 = performance.now();
  const extents = await loadExtents(pool, segments);
  stages.push(["extents", ms(t0)]);

  t0 = performance.now();
  const graph = buildPathGraph({ segments, extents, transitions, decidable: insideBox(box, PATH_EDGE_M) });
  const segment = graph.segments.get(press.segmentId)!;
  let atM = Math.max(0, Math.min(segment.lengthM, travelMAt(segment, press.direction, [press.lon, press.lat])));
  const extent = graph.extents.get(lineKey(press));
  if (extent) atM = Math.max(extent.fromM, Math.min(extent.toM, atM));
  const grown = growPath(graph, { segmentId: press.segmentId, direction: press.direction, atM }, { avoid: [] });
  stages.push(["graph + growth (memory)", ms(t0)]);

  t0 = performance.now();
  const { lines, rides } = await loadLineData(pool, graph.segments, grown.pieces.map((p) => p.segmentId));
  stages.push(["line data", ms(t0)]);

  t0 = performance.now();
  const body = JSON.stringify(pathResponse(graph, grown.pieces, grown.stop, lines, rides));
  stages.push(["response (memory)", ms(t0)]);
  return { totalMs: ms(t), stages, bodyKb: body.length / 1024, pieces: grown.pieces.length };
}

const line = (name: string, run: Awaited<ReturnType<typeof request>>) =>
  `${name}: total ${fmt(run.totalMs)} (${run.stages.map(([stage, m]) => `${stage} ${fmt(m)}`).join(", ")})`;

// Closes every connection the pool holds, as a long enough pause would: each
// idle one is checked out and released destroyed, not returned.
async function closeAll() {
  const idle = await Promise.all(Array.from({ length: pool.idleCount }, () => pool.connect()));
  for (const client of idle) client.release(true);
  if (pool.totalCount !== 0) throw new Error(`still ${pool.totalCount} connection(s) open`);
}

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
  console.log(`time:path from this machine to ${host}`);

  // A new connection's cost: the first statement on an empty pool, against a warm round trip.
  let t0 = performance.now();
  await pool.query<{ one: number }>("select 1 as one");
  const firstMs = ms(t0);
  const trips: number[] = [];
  for (let i = 0; i < 3; i++) {
    t0 = performance.now();
    await pool.query<{ one: number }>("select 1 as one");
    trips.push(ms(t0));
  }
  console.log(`a round trip (select 1, warm): ${trips.map(fmt).join(", ")}; a new connection costs ${fmt(firstMs - Math.min(...trips))} more\n`);

  const [a, b] = PRESSES as [(typeof PRESSES)[number], (typeof PRESSES)[number]];
  const warmA = await request(a);
  const warmB = await request(b);
  console.log(line(`${a.name}, warm`, warmA));
  console.log(line(`${b.name}, warm`, warmB));
  console.log(`  ${a.name}: ${warmA.pieces} pieces, ${warmA.bodyKb.toFixed(0)}KB; ${b.name}: ${warmB.pieces} pieces, ${warmB.bodyKb.toFixed(0)}KB`);

  // The case the phone meets after a pause long enough to close every connection.
  await closeAll();
  const cold = await request(a);
  console.log(line(`${a.name}, cold`, cold) + `; it opened ${pool.totalCount} connection(s)`);
  await pool.end();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
