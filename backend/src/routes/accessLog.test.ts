import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { accessLog } from "./accessLog.js";
import { traceOf } from "./requestTrace.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// An app as index.ts builds it: the access log first, then the routes.
async function serve(t: TestContext) {
  const lines: string[] = [];
  let logged: () => void = () => undefined;
  t.mock.method(console, "log", (line: string) => {
    lines.push(line);
    logged();
  });
  const nextLine = () => new Promise<void>((resolve) => (logged = resolve));
  const app = express();
  app.use(accessLog);
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/work", async (_req, res) => {
    await traceOf(res).time("db", sleep(20));
    res.json({ done: true });
  });
  app.get("/slow", async (_req, res) => {
    await sleep(300);
    res.json({ late: true });
  });
  app.post("/upload", (req, res) => res.json({ got: Object.keys(req.body as object).length }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { lines, nextLine, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("a request's line: method, url, status, server time, then the pool and each stage its route timed", async (t) => {
  const { lines, nextLine, base } = await serve(t);
  const line = nextLine();
  assert.equal((await fetch(`${base}/work?a=1`)).status, 200);
  await line;
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^GET \/work\?a=1 200 (\d+)ms pool=\d+\/\d+\/\d+ opened=\d+ db=\d+-(\d+) finish=\d+$/);
  const [, totalMs, dbEnd] = /^GET \S+ 200 (\d+)ms .* db=\d+-(\d+)/.exec(lines[0]!)!;
  assert.ok(Number(dbEnd) >= 18 && Number(totalMs) >= Number(dbEnd), lines[0]);
});

test("the line keeps the shape split:access-log has always read, and an upload's size", async (t) => {
  const { lines, nextLine, base } = await serve(t);
  const line = nextLine();
  await fetch(`${base}/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1, b: 2 }) });
  await line;
  assert.match(lines[0]!, /^POST \/upload 200 \d+ms 13B pool=/);
  assert.match(lines[0]!, /^(GET|POST|PUT|DELETE) (\S+) (\d{3})( ABORTED-BY-CLIENT)? (\d+)ms/);
});

test("/health is not logged", async (t) => {
  const { lines, base } = await serve(t);
  await fetch(`${base}/health`);
  await sleep(50);
  assert.deepEqual(lines, []);
});

test("a request the client gave up on is logged as aborted, with no finish", async (t) => {
  const { lines, nextLine, base } = await serve(t);
  const line = nextLine();
  const req = http.get(`${base}/slow`);
  req.on("error", () => undefined);
  await sleep(50);
  req.destroy();
  await line;
  assert.match(lines[0]!, /^GET \/slow 200 ABORTED-BY-CLIENT \d+ms pool=\d+\/\d+\/\d+ opened=\d+$/);
});
