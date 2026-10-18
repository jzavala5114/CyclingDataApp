import { test } from "node:test";
import assert from "node:assert/strict";
import { kindOf, parseLog, parseTrace, report, stageDurations } from "./splitAccessLog.js";
import { RequestTrace } from "../routes/requestTrace.js";

// Lines as `railway logs --json` prints them: one JSON object per line, the
// access log's line in `message`, stamped when Railway ingested it.
const entry = (timestamp: string, message: string) => JSON.stringify({ message, timestamp, level: "info" });
const TRACED =
  "GET /segments/path?segmentId=19475&direction=forward&lon=-104.8&lat=38.8 200 762ms pool=4/4/0 opened=0 " +
  "network=0-610 rideOrder=0-120 extents=611-640 growth=640-655 lines=655-740 respond=740-743 finish=760";
const LOG = [
  entry("2026-10-18T17:30:25.100Z", "GET /segments/path?segmentId=19475&direction=forward&lon=-104.8&lat=38.8 200 263ms"),
  entry("2026-10-18T17:12:24.293Z", "backend listening on :8080"),
  entry("2026-10-18T17:31:05.000Z", TRACED),
  entry("2026-10-18T17:31:06.000Z", "GET /segments?minLon=-180&maxLon=180&minLat=-90&maxLat=90 200 900ms pool=3/4/0 opened=1"),
  entry("2026-10-18T17:31:07.000Z", "POST /sessions/7/samples 200 ABORTED-BY-CLIENT 20000ms 51234B pool=4/4/0 opened=0"),
].join("\n");

test("it reads the access log's lines in time order, old ones without a trace and new ones with", () => {
  const rows = parseLog(LOG);
  assert.deepEqual(rows.map((r) => [r.path, r.status, r.aborted, r.ms]), [
    ["/segments/path", 200, false, 263],
    ["/segments/path", 200, false, 762],
    ["/segments", 200, false, 900],
    ["/sessions/7/samples", 200, true, 20000],
  ]);
  assert.equal(rows[0]!.trace, null);
  assert.deepEqual(rows[1]!.trace!.pool, { idle: 4, total: 4, waiting: 0 });
  // Quiet before the second: it arrived 762ms before 17:31:05, 39.1s after the first ended.
  assert.ok(Math.abs(rows[1]!.quietS! - 39.138) < 1e-9, String(rows[1]!.quietS));
  assert.deepEqual(rows.map(kindOf), ["path:from", "path:from", "tiles:world", "/sessions/7/samples"]);
});

test("a path request's stages, and the time handing the answer over, from its trace", () => {
  const [, traced] = parseLog(LOG);
  assert.deepEqual(Object.fromEntries(stageDurations(traced!)!), {
    network: 610,
    rideOrder: 120,
    extents: 29,
    growth: 15,
    lines: 85,
    respond: 3,
    deliver: 17,
    toClose: 2,
  });
});

test("it reads the fields the server's trace writes", () => {
  const trace = new RequestTrace(() => ({ total: 2, idle: 1, waiting: 0, opened: 5 }));
  trace.timeSync("network", () => undefined);
  trace.mark("growth");
  trace.finished();
  const parsed = parseTrace(`GET /segments/path?x=1 200 12ms ${trace.logFields()}`)!;
  assert.deepEqual(parsed.pool, { idle: 1, total: 2, waiting: 0 });
  assert.equal(parsed.opened, 0);
  assert.deepEqual([...parsed.stages.keys()], ["network", "growth"]);
  assert.equal(typeof parsed.finishMs, "number");
  assert.equal(parseTrace("GET /segments/path?x=1 200 12ms"), null);
});

test("the report splits path requests by the quiet before them, and shows the median of each stage", () => {
  const out = report(parseLog(LOG));
  assert.equal(out[0], "window start .. end: 4 requests");
  assert.ok(out.includes("path after quiet >= 30s    : n=1 median 762ms p90 762ms max 762ms min 762ms"), out.join("\n"));
  const quietRow = out.find((l) => l.startsWith("  after quiet >= 30s"))!;
  assert.match(quietRow, /^ {2}after quiet >= 30s\s+610\s+120\s+29\s+15\s+85\s+3\s+17\s+2 {3}opened a connection: 0 of 1$/);
  assert.ok(out.some((l) => l.includes("762ms 19475 | pool 4/4/0 opened 0 | network 610, rideOrder 120")), out.join("\n"));
  const windowed = report(parseLog(LOG), "2026-10-18T17:31:00Z", "2026-10-18T17:31:06.5Z");
  assert.equal(windowed[0], "window 2026-10-18T17:31:00Z .. 2026-10-18T17:31:06.5Z: 2 requests");
});
