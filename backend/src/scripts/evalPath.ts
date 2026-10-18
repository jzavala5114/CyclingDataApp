import "dotenv/config";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { pool } from "../db/pool.js";
import { segmentsRouter } from "../routes/segments.js";
import {
  buildPathGraph,
  candidatesAt,
  DEFAULT_RULES,
  drawnRanges,
  growPath,
  lineKey,
  pickNext,
  type Candidate,
  type PathGraph,
  type RuleName,
  type StopReason,
} from "../services/pathGrowth.js";
import { loadExtents, loadLineData, loadTransitions } from "../services/pathData.js";
import type { Direction, Segment } from "../types/index.js";

// How well a press-and-hold selection grows, measured on the stored rides.
// Read-only: every connection is set read-only before its first query, and
// the work runs inside BEGIN READ ONLY. It needs only DATABASE_URL.
//
//   npm run eval:path
//
// 1. The fork rule, leave-one-ride-out. For every pair of stored lines a ride
//    went straight from one to the next, at a junction offering two ways or
//    more: does the rule pick the way that ride went, judged on every OTHER
//    ride's history? A stop is not a wrong pick; the card asks the rider to
//    hold a branch instead. Scored for the rule as shipped (history first),
//    name first, no history at all, and the least turn always, the baseline.
// 2. Growth from the start of every drawn line: why it stops, how far it gets,
//    and how much of it has no data, with and without the 5m snap.
// 3. The route itself, timed end to end in-process, at 20 presses.
// 4. Each line of Ladders and Gold Camp Road against the terrain model: the
//    card's net change and climb beside the DEM's. Reported, not judged: on
//    singletrack the DEM samples a centreline the rider was not on.
//
// Exits 1 unless the rule as shipped picks the way rides went more often than
// the least turn does AND more often than the same rule without its history.
// The second half is what judges Julian's history rule: without it the eval
// passed with the history rule deleted, because names and turns alone beat the
// least turn (608 against 548 of 810 forks through ride 89; cold review,
// 2026-10-17). Shown to fail both ways: with DEFAULT_RULES set to ["least"],
// or to ["name", "turn", "only"].

// Segments within this many degrees (about 330m north-south) of any drawn
// line: everything growth can reach, since it never runs more than 150m from
// data.
const CORRIDOR_DEG = 0.003;
// Presses the route is timed at.
const ROUTE_PRESSES = 20;

const NAMED = ["ladders", "gold camp road"];

pool.on("connect", (connection) => {
  void connection.query("set default_transaction_read_only = on");
});

const ms = (t0: number) => Math.round(performance.now() - t0);
const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);
const km = (m: number) => (m / 1000).toFixed(2);

let corridor: Segment[] = [];
let corridorMs = 0;
let extentsMs = 0;
let transitionsMs = 0;
let extents = new Map<string, { fromM: number; toM: number }>();
let transitions: Awaited<ReturnType<typeof loadTransitions>> = [];
const routeRuns: Array<{ ms: number; kb: number; km: number; reason: StopReason }> = [];
let named: { lines: Awaited<ReturnType<typeof loadLineData>>["lines"]; dem: Map<string, Array<{ distanceM: number; elevationM: number }>> } | null =
  null;

const client = await pool.connect();
try {
  await client.query("begin transaction read only");

  let t0 = performance.now();
  ({ rows: corridor } = await client.query<Segment>(
    `with drawn as (
       select s.geom from segments s
        where exists (select 1 from segment_elevation_buckets b where b.segment_id = s.id)
     ), near as (
       -- Driven from the few hundred drawn segments, so each one is an index
       -- lookup; asked the other way round, per segment of the city, this took
       -- 68 s.
       select distinct n.osm_way_id, least(n.start_node_id, n.end_node_id) as lo,
              greatest(n.start_node_id, n.end_node_id) as hi
         from drawn d
         join segments n on n.geom && ST_Expand(d.geom, $1)
        where n.canonical_segment_id is null
     )
     select distinct on (s.id)
            s.id, s.osm_way_id as "osmWayId", s.kind, s.street_name as "streetName",
            s.start_node_id as "startNodeId", s.end_node_id as "endNodeId", s.piece_index as "pieceIndex",
            ST_AsGeoJSON(s.geom)::json as geom, s.length_m as "lengthM", s.bearing_deg as "bearingDeg"
       from near b
       join segments s
         on s.osm_way_id = b.osm_way_id
        and least(s.start_node_id, s.end_node_id) = b.lo
        and greatest(s.start_node_id, s.end_node_id) = b.hi
      where s.canonical_segment_id is null
      order by s.id`,
    [CORRIDOR_DEG],
  ));
  corridorMs = ms(t0);

  t0 = performance.now();
  extents = await loadExtents(client, corridor);
  extentsMs = ms(t0);
  t0 = performance.now();
  transitions = await loadTransitions(client);
  transitionsMs = ms(t0);

  // The route itself, in-process over HTTP from this PC, at presses spread
  // through the drawn lines: one request first to open the pool's
  // connections, as a running server has them open, then each timed.
  const byId = new Map(corridor.map((s) => [s.id, s]));
  const drawnKeys = [...extents.keys()].sort();
  const step = Math.max(1, Math.floor(drawnKeys.length / ROUTE_PRESSES));
  const presses = drawnKeys.filter((_, i) => i % step === 0).slice(0, ROUTE_PRESSES + 1);
  const server = express().use("/segments", segmentsRouter).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [n, key] of presses.entries()) {
      const [id, direction] = key.split(":") as [string, Direction];
      const segment = byId.get(Number(id))!;
      const extent = extents.get(key)!;
      const [lon, lat] = direction === "forward" ? segment.geom.coordinates[0]! : segment.geom.coordinates.at(-1)!;
      const query = new URLSearchParams({
        segmentId: id,
        direction,
        lon: String(lon),
        lat: String(lat),
        atM: String(extent.fromM),
      });
      const t1 = performance.now();
      const res = await fetch(`${base}/segments/path?${query}`);
      const text = await res.text();
      const elapsed = performance.now() - t1;
      if (!res.ok) throw new Error(`GET /segments/path?${query}: HTTP ${res.status} ${text}`);
      if (n === 0) continue;
      const body = JSON.parse(text) as { lengthM: number; stop: { reason: StopReason } };
      routeRuns.push({ ms: elapsed, kb: text.length / 1024, km: body.lengthM / 1000, reason: body.stop.reason });
    }
  } finally {
    server.close();
  }

  // The named streets, for the terrain comparison.
  const namedIds = corridor
    .filter((s) => NAMED.includes((s.streetName ?? "").trim().toLowerCase()))
    .map((s) => s.id);
  if (namedIds.length > 0) {
    const { lines } = await loadLineData(pool, byId, namedIds);
    const { rows: demRows } = await client.query<{
      segmentId: number;
      direction: Direction;
      distanceM: number;
      elevationM: number;
    }>(
      `select segment_id as "segmentId", direction, distance_m as "distanceM", elevation_m as "elevationM"
         from segment_dem_elevations
        where segment_id = any($1)`,
      [namedIds],
    );
    const dem = new Map<string, Array<{ distanceM: number; elevationM: number }>>();
    for (const row of demRows) {
      const key = lineKey(row);
      const list = dem.get(key) ?? [];
      list.push({ distanceM: row.distanceM, elevationM: row.elevationM });
      dem.set(key, list);
    }
    named = { lines, dem };
  }
  await client.query("rollback");
} finally {
  client.release();
  await pool.end();
}

const graph = buildPathGraph({ segments: corridor, extents, transitions });
const graph0 = buildPathGraph({ segments: corridor, extents, transitions, snapM: 0 });
const drawnLines = [...extents.keys()].sort().map((key) => {
  const [id, direction] = key.split(":") as [string, Direction];
  return { segmentId: Number(id), direction, extent: extents.get(key)! };
});

console.log("eval:path, read-only");
console.log(
  `corridor: ${corridor.length} canonical segments (${corridorMs} ms), ${drawnLines.length} drawn lines` +
    ` (${extentsMs} ms), ${transitions.length} stored transitions over ${new Set(transitions.map((t) => t.sessionId)).size} rides (${transitionsMs} ms)`,
);

// ---- 1. the fork rule, leave-one-ride-out ----------------------------------

const ORDERS: Array<[string, readonly RuleName[]]> = [
  ["history first (shipped)", DEFAULT_RULES],
  ["name first", ["name", "history", "turn", "only"]],
  ["no history", ["name", "turn", "only"]],
  ["least turn always", ["least"]],
];
const candidatesCache = new Map<string, Candidate[]>();
const candidatesFor = (g: PathGraph, segmentId: number, direction: Direction) => {
  const key = `${g === graph ? 5 : 0}|${segmentId}:${direction}`;
  let found = candidatesCache.get(key);
  if (!found) candidatesCache.set(key, (found = candidatesAt(g, { segmentId, direction })));
  return found;
};

let notTouching = 0;
let turnedAround = 0;
let otherWay = 0;
let noChoice = 0;
const cases: Array<{ sessionId: number; from: { segmentId: number; direction: Direction }; to: string; candidates: Candidate[] }> = [];
for (const t of transitions) {
  const candidates = candidatesFor(graph, t.from.segmentId, t.from.direction);
  if (!candidates.some((c) => c.key === lineKey(t.to))) {
    if (t.to.segmentId === t.from.segmentId) turnedAround++;
    else if (candidates.some((c) => c.segmentId === t.to.segmentId)) otherWay++;
    else notTouching++;
  } else if (candidates.length < 2) noChoice++;
  else cases.push({ sessionId: t.sessionId, from: t.from, to: lineKey(t.to), candidates });
}
console.log(
  `\n1. FORKS RIDDEN: ${cases.length} of ${transitions.length} transitions are at a fork of two ways or more;` +
    ` ${noChoice} had one way on. Not offered by the graph: ${turnedAround} turn round on the same segment,` +
    ` ${otherWay} go on into a neighbour the other way from the end it touches,` +
    ` ${notTouching} go to a line that does not touch (a dropped run between them)`,
);
const score = (rules: readonly RuleName[]) => {
  let correct = 0;
  let wrong = 0;
  let stopped = 0;
  const byRule = new Map<string, { correct: number; wrong: number }>();
  for (const c of cases) {
    const picked = pickNext(graph, c.from, c.candidates, { rules, excludeSession: c.sessionId });
    if (!picked) {
      stopped++;
      continue;
    }
    const tally = byRule.get(picked.rule) ?? { correct: 0, wrong: 0 };
    if (picked.candidate.key === c.to) {
      correct++;
      tally.correct++;
    } else {
      wrong++;
      tally.wrong++;
    }
    byRule.set(picked.rule, tally);
  }
  return { correct, wrong, stopped, byRule };
};
const scores = new Map(ORDERS.map(([label, rules]) => [label, score(rules)]));
console.log("   rule order                  right      wrong      stopped    (decided by: right/wrong)");
for (const [label, s] of scores) {
  const by = [...s.byRule].map(([rule, t]) => `${rule} ${t.correct}/${t.wrong}`).join(", ");
  console.log(
    `   ${label.padEnd(26)}  ${pct(s.correct, cases.length).padStart(6)}     ${pct(s.wrong, cases.length).padStart(6)}     ${pct(s.stopped, cases.length).padStart(6)}     (${by})`,
  );
}
const forkSizes = new Map<number, number>();
for (const c of cases) forkSizes.set(c.candidates.length, (forkSizes.get(c.candidates.length) ?? 0) + 1);
console.log(`   ways at those forks: ${[...forkSizes].sort((a, b) => a[0] - b[0]).map(([n, k]) => `${n}: ${k}`).join(", ")}`);

// ---- 2. growth from every drawn line ---------------------------------------

const census = (g: PathGraph) => {
  const reasons = new Map<StopReason, number>();
  const metres = { line: 0, twin: 0, none: 0 };
  const rules = new Map<string, number>();
  const lengths: number[] = [];
  for (const line of drawnLines) {
    const grown = growPath(g, { segmentId: line.segmentId, direction: line.direction, atM: line.extent.fromM });
    reasons.set(grown.stop.reason, (reasons.get(grown.stop.reason) ?? 0) + 1);
    lengths.push(grown.lengthM);
    for (const p of grown.pieces) {
      metres[p.source] += p.toM - p.fromM;
      if (p.rule && p.rule !== "start") rules.set(p.rule, (rules.get(p.rule) ?? 0) + 1);
    }
  }
  lengths.sort((a, b) => a - b);
  return { reasons, metres, rules, lengths };
};
const at = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
for (const [label, g] of [
  ["5 m snap (shipped)", graph],
  ["no snap", graph0],
] as const) {
  const c = census(g);
  const total = c.metres.line + c.metres.twin + c.metres.none;
  console.log(`\n2. GROWTH from the start of each of ${drawnLines.length} drawn lines, ${label}`);
  console.log(
    `   stops: ${(["end", "fork", "gap", "loop", "limit"] as StopReason[]).map((r) => `${r} ${c.reasons.get(r) ?? 0}`).join(", ")}`,
  );
  console.log(
    `   length: median ${km(at(c.lengths, 0.5))} km, p90 ${km(at(c.lengths, 0.9))} km, max ${km(c.lengths.at(-1) ?? 0)} km;` +
      ` under 100 m: ${c.lengths.filter((m) => m < 100).length}`,
  );
  console.log(
    `   ground: ${km(total)} km grown, own data ${pct(c.metres.line, total)}, other direction ${pct(c.metres.twin, total)},` +
      ` no data ${pct(c.metres.none, total)} = ${Math.round((10_000 * c.metres.none) / Math.max(1, total))} m per 10 km`,
  );
  console.log(`   junctions taken by: ${[...c.rules].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", ")}`);
}

// ---- 3. the route's loading -------------------------------------------------

{
  const times = routeRuns.map((r) => r.ms).sort((a, b) => a - b);
  const reasons = new Map<StopReason, number>();
  for (const r of routeRuns) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  console.log(`\n3. THE ROUTE, end to end in-process from this PC, ${routeRuns.length} presses after one to warm up`);
  console.log(
    `   ms: median ${Math.round(at(times, 0.5))}, p95 ${Math.round(at(times, 0.95))}, max ${Math.round(times.at(-1) ?? 0)};` +
      ` response median ${at(routeRuns.map((r) => r.kb).sort((a, b) => a - b), 0.5).toFixed(0)} KB;` +
      ` path median ${at(routeRuns.map((r) => r.km).sort((a, b) => a - b), 0.5).toFixed(2)} km`,
  );
  console.log(`   stops: ${[...reasons].map(([r, k]) => `${r} ${k}`).join(", ")}`);
}

// ---- 4. against the terrain model --------------------------------------------

console.log("\n4. LADDERS AND GOLD CAMP ROAD against the terrain model, each line: net change and climb, metres");
if (named) {
  let lines = 0;
  let netDiff = 0;
  let cardClimb = 0;
  let demClimb = 0;
  for (const [key, data] of [...named.lines].sort()) {
    const dem = (named.dem.get(key) ?? [])
      .filter((d) => d.distanceM >= data.drawing.fromTravelM && d.distanceM <= data.drawing.toTravelM)
      .sort((a, b) => a.distanceM - b.distanceM);
    if (dem.length < 2) continue;
    const ranges = drawnRanges(data.drawing);
    const net = ranges.reduce((sum, r) => sum + (r.slopePct * (r.toM - r.fromM)) / 100, 0);
    const climb = ranges.reduce((sum, r) => sum + (Math.max(0, r.slopePct) * (r.toM - r.fromM)) / 100, 0);
    const demNet = dem.at(-1)!.elevationM - dem[0]!.elevationM;
    let demUp = 0;
    for (let i = 1; i < dem.length; i++) demUp += Math.max(0, dem[i]!.elevationM - dem[i - 1]!.elevationM);
    lines++;
    netDiff += Math.abs(net - demNet);
    cardClimb += climb;
    demClimb += demUp;
  }
  console.log(
    `   ${lines} lines: mean |net change - terrain's| ${(netDiff / Math.max(1, lines)).toFixed(2)} m;` +
      ` climb summed ${cardClimb.toFixed(1)} m on the card against ${demClimb.toFixed(1)} m in the terrain model`,
  );
} else {
  console.log("   neither street is drawn");
}

// ---- verdict ----------------------------------------------------------------

const shipped = scores.get("history first (shipped)")!;
const baseline = scores.get("least turn always")!;
const noHistory = scores.get("no history")!;
const pass = shipped.correct > baseline.correct && shipped.correct > noHistory.correct;
console.log(
  `\n${pass ? "PASS" : "FAIL"}: history first picks the way a ride went at ${shipped.correct} of ${cases.length} forks;` +
    ` it must beat the least turn (${baseline.correct}) and the same rule without history (${noHistory.correct})`,
);
process.exit(pass ? 0 : 1);
