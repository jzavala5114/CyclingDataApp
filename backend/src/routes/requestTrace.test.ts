import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { poolSnapshot, RequestTrace, type PoolSnapshot } from "./requestTrace.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A pool that opens a connection whenever the test says so.
function fakePool(idle = 2, total = 3) {
  const state: PoolSnapshot = { total, idle, waiting: 0, opened: 10 };
  return { state, snapshot: () => ({ ...state }) };
}

// name=from-to pairs from a log line, as numbers.
const spans = (fields: string) =>
  Object.fromEntries(
    [...fields.matchAll(/(\w+)=(\d+)-(\d+)/g)].map(([, name, from, to]) => [name!, [Number(from), Number(to)]] as const),
  );

test("stages run in parallel keep their own spans, and a stage of plain statements starts where the last one ended", async () => {
  const pool = fakePool();
  const trace = new RequestTrace(pool.snapshot);
  await Promise.all([trace.time("network", sleep(20)), trace.time("rideOrder", sleep(60))]);
  await sleep(15);
  trace.mark("growth");
  const s = spans(trace.logFields());
  assert.ok(s.network![0] <= 5 && s.rideOrder![0] <= 5, `both start at arrival: ${trace.logFields()}`);
  assert.ok(s.network![1] >= 18 && s.network![1] < s.rideOrder![1], `network ends first: ${trace.logFields()}`);
  assert.ok(s.rideOrder![1] >= 58);
  assert.equal(s.growth![0], s.rideOrder![1], "growth starts where the later of the two ended");
  assert.ok(s.growth![1] - s.growth![0] >= 13, `growth holds the 15ms after them: ${trace.logFields()}`);
});

test("the pool as the request found it, and the connections opened while it ran", async () => {
  const pool = fakePool(1, 4);
  const trace = new RequestTrace(pool.snapshot);
  pool.state.idle = 0;
  pool.state.opened += 2; // two new connections, during the request
  assert.match(trace.logFields(), /^pool=1\/4\/0 opened=2$/);
  assert.match(trace.serverTiming(), /^total;dur=\d+\.\d, pool;desc="idle 1 of 4 waiting 0 opened 2"$/);
});

test("a stage that fails still records how long it took", async () => {
  const trace = new RequestTrace(fakePool().snapshot);
  await assert.rejects(trace.time("network", sleep(10).then(() => Promise.reject(new Error("db down")))), /db down/);
  assert.throws(() => trace.timeSync("respond", () => { throw new Error("bad"); }), /bad/);
  assert.deepEqual(Object.keys(spans(trace.logFields())), ["network", "respond"]);
});

test("Server-Timing holds each stage's duration in the spec's form, before the answer's own serializing and delivery", async () => {
  const trace = new RequestTrace(fakePool().snapshot);
  await trace.time("extents", sleep(5));
  const header = trace.serverTiming();
  // https://www.w3.org/TR/server-timing/: metric *( ";" param ), comma-separated.
  assert.match(header, /^extents;dur=\d+\.\d, total;dur=\d+\.\d, pool;desc="idle 2 of 3 waiting 0 opened 0"$/);
  assert.ok(!/finish/.test(header));
  trace.finished();
  const once = trace.logFields();
  await sleep(5);
  trace.finished();
  assert.equal(trace.logFields(), once, "the first finish is the one kept");
  assert.match(once, / finish=\d+$/);
});

test("the pool's snapshot counts each connection the real pool opens", () => {
  const before = poolSnapshot();
  pool.emit("connect", {} as never);
  pool.emit("connect", {} as never);
  const after = poolSnapshot();
  assert.equal(after.opened - before.opened, 2);
  assert.deepEqual(
    { total: after.total, idle: after.idle, waiting: after.waiting },
    { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
  );
});
