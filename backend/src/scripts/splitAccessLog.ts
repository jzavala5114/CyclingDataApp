// npm run split:access-log -- <log.jsonl> [fromIso] [toIso]
//
// Splits the backend's access log (routes/accessLog.ts), as
// `railway logs <deploymentId> --json` prints it (run from backend/, which is
// linked to the service), into GET /segments/path and GET /segments requests
// with the server's own time for each (arrival to the response's close), the
// request's kind, and the quiet before it: the time since the previous logged
// request of any kind ended. Railway stamps lines as it ingests them, in
// batches, so gaps under a few seconds are approximate. Read-only: it reads a
// file.
//
// Lines since 2026-10-18 carry the request's trace (routes/requestTrace.ts):
// the pool as the request found it, the connections it opened, and when each
// stage started and ended. For the path requests, the medians of each stage
// after a quiet spell and warm show where a slow press spent its time.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Trace {
  pool: { idle: number; total: number; waiting: number };
  opened: number;
  stages: Map<string, { fromMs: number; toMs: number }>;
  finishMs: number | null;
}

export interface Row {
  t: number;
  iso: string;
  method: string;
  path: string;
  query: URLSearchParams;
  status: number;
  aborted: boolean;
  ms: number;
  trace: Trace | null;
  // Seconds between the previous request's end and this one's arrival.
  quietS: number | null;
}

const LINE = /^(GET|POST|PUT|DELETE) (\S+) (\d{3})( ABORTED-BY-CLIENT)? (\d+)ms/;

export function parseTrace(message: string): Trace | null {
  const pool = /\bpool=(\d+)\/(\d+)\/(\d+)\b/.exec(message);
  const opened = /\bopened=(\d+)\b/.exec(message);
  if (!pool || !opened) return null;
  const stages = new Map<string, { fromMs: number; toMs: number }>();
  for (const [, name, from, to] of message.matchAll(/\b(\w+)=(\d+)-(\d+)\b/g)) {
    stages.set(name!, { fromMs: Number(from), toMs: Number(to) });
  }
  const finish = /\bfinish=(\d+)\b/.exec(message);
  return {
    pool: { idle: Number(pool[1]), total: Number(pool[2]), waiting: Number(pool[3]) },
    opened: Number(opened[1]),
    stages,
    finishMs: finish ? Number(finish[1]) : null,
  };
}

// Every access-log line in a `railway logs --json` file, in time order.
export function parseLog(jsonl: string): Row[] {
  const rows: Row[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { message?: string; timestamp: string };
    const m = LINE.exec(entry.message ?? "");
    if (!m) continue;
    const url = new URL(m[2]!, "http://x");
    rows.push({
      t: Date.parse(entry.timestamp),
      iso: entry.timestamp.slice(0, 19),
      method: m[1]!,
      path: url.pathname,
      query: url.searchParams,
      status: Number(m[3]),
      aborted: m[4] !== undefined,
      ms: Number(m[5]),
      trace: parseTrace(entry.message!),
      quietS: null,
    });
  }
  rows.sort((a, b) => a.t - b.t);
  // A line is stamped when the request ends: its arrival is ms earlier.
  for (let i = 1; i < rows.length; i++) rows[i]!.quietS = (rows[i]!.t - rows[i]!.ms - rows[i - 1]!.t) / 1000;
  return rows;
}

export function kindOf(row: Row): string {
  if (row.path === "/segments") {
    const width = Number(row.query.get("maxLon")) - Number(row.query.get("minLon"));
    return width > 100 ? "tiles:world" : "tiles:box";
  }
  if (row.path !== "/segments/path") return row.path;
  const kind = row.query.has("toSegmentId") ? (row.query.get("grow") === "false" ? "path:connect-only" : "path:connect+grow") : "path:from";
  return kind + (row.query.has("avoid") ? "+avoid" : "");
}

// The time a path request spent in each stage, in the order they run, then
// handing the answer over (respond's end to finish) and the rest to close.
export function stageDurations(row: Row): Map<string, number> | null {
  if (row.trace === null) return null;
  const out = new Map<string, number>();
  for (const [name, s] of row.trace.stages) out.set(name, s.toMs - s.fromMs);
  const respond = row.trace.stages.get("respond");
  if (respond && row.trace.finishMs !== null) {
    out.set("deliver", row.trace.finishMs - respond.toMs);
    out.set("toClose", row.ms - row.trace.finishMs);
  }
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!;
};
const summary = (label: string, xs: number[]) =>
  xs.length === 0
    ? `${label}: none`
    : `${label}: n=${xs.length} median ${pct(xs, 0.5)}ms p90 ${pct(xs, 0.9)}ms max ${Math.max(...xs)}ms min ${Math.min(...xs)}ms`;

const STAGE_ORDER = ["network", "rideOrder", "extents", "growth", "lines", "respond", "deliver", "toClose"];

// Median ms per stage across rows that carry a trace, as one table row.
function stageMedians(label: string, rows: Row[]): string {
  const traced = rows.map(stageDurations).filter((d): d is Map<string, number> => d !== null);
  if (traced.length === 0) return `${label.padEnd(28)} (no trace)`;
  const cells = STAGE_ORDER.map((name) => {
    const xs = traced.map((d) => d.get(name)).filter((x): x is number => x !== undefined);
    return (xs.length > 0 ? String(pct(xs, 0.5)) : "-").padStart(name.length + 1);
  });
  const opened = rows.filter((r) => r.trace !== null && r.trace.opened > 0).length;
  return `${label.padEnd(28)}${cells.join("")}   opened a connection: ${opened} of ${traced.length}`;
}

export function report(all: Row[], fromIso?: string, toIso?: string): string[] {
  const from = fromIso ? Date.parse(fromIso) : -Infinity;
  const to = toIso ? Date.parse(toIso) : Infinity;
  const rows = all.filter((r) => r.t >= from && r.t <= to);
  const out = [`window ${fromIso ?? "start"} .. ${toIso ?? "end"}: ${rows.length} requests`];
  for (const kind of [...new Set(rows.map(kindOf))].sort()) {
    out.push(summary(kind.padEnd(26), rows.filter((r) => kindOf(r) === kind).map((r) => r.ms)));
  }
  const paths = rows.filter((r) => r.path === "/segments/path");
  const quiet = paths.filter((r) => r.quietS !== null && r.quietS >= 30);
  const middling = paths.filter((r) => r.quietS !== null && r.quietS >= 5 && r.quietS < 30);
  const warm = paths.filter((r) => r.quietS !== null && r.quietS < 5);
  out.push(summary("path after quiet >= 30s    ", quiet.map((r) => r.ms)));
  out.push(summary("path after quiet 5..30s    ", middling.map((r) => r.ms)));
  out.push(summary("path after quiet < 5s      ", warm.map((r) => r.ms)));
  out.push(summary("aborted by client          ", rows.filter((r) => r.aborted).map((r) => r.ms)));
  if (paths.some((r) => r.trace !== null)) {
    out.push("", `path stages, median ms:    ${STAGE_ORDER.map((n) => n.padStart(n.length + 1)).join("")}`);
    out.push(stageMedians("  after quiet >= 30s", quiet));
    out.push(stageMedians("  after quiet < 5s", warm));
    const slow = paths.filter((r) => r.ms >= 500);
    out.push(stageMedians("  every path at 500ms or more", slow));
  }
  out.push("", "every request (UTC, quiet seconds before it, kind, status, server ms, segment, then its trace):");
  for (const r of rows) {
    const quietS = r.quietS === null ? "   - " : r.quietS.toFixed(0).padStart(5);
    const avoid = r.query.has("avoid") ? ` avoid=${r.query.get("avoid")!.split(",").length}` : "";
    const durations = stageDurations(r);
    const trace = r.trace
      ? ` | pool ${r.trace.pool.idle}/${r.trace.pool.total}/${r.trace.pool.waiting} opened ${r.trace.opened}` +
        (durations ? ` | ${[...durations].map(([n, ms]) => `${n} ${ms}`).join(", ")}` : "")
      : "";
    out.push(
      `${r.iso} quiet ${quietS}s ${kindOf(r).padEnd(24)} ${r.status}${r.aborted ? " ABORTED" : ""} ${String(r.ms).padStart(5)}ms ` +
        `${r.query.get("segmentId") ?? ""}${avoid}${trace}`,
    );
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, fromIso, toIso] = process.argv.slice(2);
  if (!file) {
    console.error("usage: npm run split:access-log -- <railway logs --json file> [fromIso] [toIso]");
    process.exit(2);
  }
  for (const line of report(parseLog(readFileSync(file, "utf8")), fromIso, toIso)) console.log(line);
}
