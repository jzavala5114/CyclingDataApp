import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { BUDGET, describeServerTiming, judge, measure, parseServerTiming, type Answer, type Run } from "./evalLatency.js";
import { RequestTrace } from "../routes/requestTrace.js";

// eval:latency's verdict. A cold review (2026-10-18, F2) passed it against a
// stub that answered every warm request with HTTP 500, and one press after
// quiet in 6s: the warm statuses were never read, and the quiet case was
// judged on the median of three.

const answer = (label: string, ms: number, status = 200): Answer => ({
  label,
  ms,
  status,
  edge: null,
  bytes: 1000,
  reused: true,
  serverTiming: null,
  body: "",
});

const goodRun = (): Run => ({
  builtAtBefore: "b1",
  builtAtAfter: "b1",
  firsts: [answer("trails first", 900), answer("downtown first", 950)],
  warm: [answer("w1", 400), answer("w2", 420), answer("w3", 380), answer("w4", 410)],
  quiet: [answer("q1", 480), answer("q2", 500), answer("q3", 470)],
});

test("the budget is the one frozen before the fix: warm median 1000ms, every press after quiet 1200ms", () => {
  assert.deepEqual(BUDGET, { warmMedianMs: 1000, quietEachMs: 1200 });
});

test("a run inside the budget, every request 200, passes", () => {
  assert.deepEqual(judge(goodRun()), []);
});

test("A WARM REQUEST THAT FAILS fails the run, though it answered fast", () => {
  const run = goodRun();
  run.warm[1] = answer("trails warm 2", 5, 500);
  assert.deepEqual(judge(run), ["trails warm 2 answered HTTP 500"]);
  const first = goodRun();
  first.firsts[0] = answer("trails first", 300, 404);
  assert.deepEqual(judge(first), ["trails first answered HTTP 404"]);
});

test("ONE SLOW PRESS AFTER QUIET fails the run, though the median of three is fast", () => {
  const run = goodRun();
  run.quiet = [answer("q1", 300), answer("q2", 6000), answer("q3", 300)];
  assert.deepEqual(judge(run), ["q2 took 6000ms, over 1200ms"]);
  const edge = goodRun();
  edge.quiet[0] = answer("q1", 1200);
  assert.deepEqual(judge(edge), [], "1200ms is at most 1200ms");
});

test("a warm median over budget fails; a run that measured nothing cannot pass", () => {
  const slow = goodRun();
  slow.warm = [answer("w1", 1100), answer("w2", 1001), answer("w3", 300)];
  assert.deepEqual(judge(slow), ["warm median 1001ms is over 1000ms"]);
  const empty = goodRun();
  empty.warm = [];
  empty.quiet = [];
  assert.deepEqual(judge(empty), ["no warm press was measured", "no press after quiet was measured"]);
});

test("a deploy during the run, or /health not answering, fails it", () => {
  const moved = goodRun();
  moved.builtAtAfter = "b2";
  assert.match(judge(moved).join(), /builtAt moved from b1 to b2/);
  const down = goodRun();
  down.builtAtBefore = null;
  assert.deepEqual(judge(down), ["/health did not answer 200 with a builtAt"]);
});

test("measured against a server whose warm requests fail, every status reaches the verdict", async () => {
  // The review's stub, over HTTP: a press's first request answers, its
  // repeats are a 500, and the second press after quiet is slow.
  let paths = 0;
  const server = http
    .createServer((req, res) => {
      if (req.url === "/health") return res.end(JSON.stringify({ ok: true, builtAt: "stub" }));
      paths += 1;
      const first = paths === 1 || paths === 5;
      const quiet = paths >= 9;
      const delay = paths === 10 ? 150 : 1;
      setTimeout(() => {
        res.statusCode = first || quiet ? 200 : 500;
        res.setHeader("Server-Timing", 'network;dur=12.5, total;dur=20.0, pool;desc="idle 1 of 2 waiting 0 opened 1"');
        res.end("x".repeat(100));
      }, delay);
    })
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const lines: string[] = [];
    const run = await measure(
      `http://127.0.0.1:${port}`,
      { quietMs: 5, quietSamples: 3, warmRuns: 3, presses: [{ name: "a", query: "x=1" }, { name: "b", query: "x=2" }] },
      (line) => lines.push(line),
    );
    assert.equal(run.firsts.length + run.warm.length + run.quiet.length, 11);
    const failures = judge(run, { warmMedianMs: 1000, quietEachMs: 100 });
    assert.deepEqual(failures.filter((f) => f.includes("HTTP")), [
      "a warm 1 answered HTTP 500",
      "a warm 2 answered HTTP 500",
      "a warm 3 answered HTTP 500",
      "b warm 1 answered HTTP 500",
      "b warm 2 answered HTTP 500",
      "b warm 3 answered HTTP 500",
    ]);
    assert.ok(failures.some((f) => /^a after 0.005s quiet, 2 took \d+ms, over 100ms$/.test(f)), failures.join("\n"));
    assert.ok(run.quiet.every((a) => a.reused), "the quiet presses reuse the kept-alive connection");
    assert.match(lines.find((l) => l.startsWith("a first"))!, /server 20ms before the answer: network 13; idle 1 of 2 waiting 0 opened 1/);
  } finally {
    server.close();
  }
});

test("the eval reads the Server-Timing header the server's trace writes", () => {
  const trace = new RequestTrace(() => ({ total: 4, idle: 3, waiting: 0, opened: 7 }));
  trace.timeSync("network", () => undefined);
  trace.mark("growth");
  const metrics = parseServerTiming(trace.serverTiming());
  assert.deepEqual(metrics.map((m) => m.name), ["network", "growth", "total", "pool"]);
  assert.ok(metrics.slice(0, 3).every((m) => typeof m.dur === "number" && m.dur >= 0));
  assert.equal(metrics[3]!.desc, "idle 3 of 4 waiting 0 opened 0");
  assert.match(describeServerTiming(trace.serverTiming()), /^server \d+ms before the answer: network \d+, growth \d+; idle 3 of 4 waiting 0 opened 0$/);
  assert.equal(describeServerTiming(null), "no Server-Timing");
});
