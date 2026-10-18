// npm run eval:latency
//
// How long the deployed backend takes to answer a press, end to end from
// wherever this runs, as the phone asks: warm (back to back) and after 40s of
// quiet, longer than the database pool's old 30s idle timeout. GET only:
// /health, then GET /segments/path. Never run it while a deploy is rolling out
// (context/session.md, "Never send traffic to a deploying container"): it
// checks /health's builtAt before and after, and fails if it moved.
//
// Requests share one kept-alive connection, as the phone's HTTP client keeps
// one for minutes: node's fetch drops an idle connection after 4s, so every
// press after a pause would also pay this machine's TLS handshake, which the
// phone does not. Each answer says whether the connection was reused, and
// what the server's Server-Timing header says it spent (routes/requestTrace.ts),
// so a slow answer shows whether the time went in the server or on the way.
//
// The budget, set 2026-10-18 before the fix (the lag: measured from the
// access log, a press took a median 1170ms on the server warm and 2840ms
// after 30s or more of quiet, with the backend in Amsterdam and its database
// in Oregon): from this PC, warm median at most 1000ms, and every press after
// 40s of quiet at most 1200ms. Every request must answer 200. The server's own
// time is in the access log (npm run split:access-log), where the budget is
// 500ms warm and 600ms after quiet.
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

export const BUDGET = { warmMedianMs: 1000, quietEachMs: 1200 } as const;

// Real presses, from the access log and eval:selection: a trail and downtown.
export const PRESSES = [
  { name: "trails 19475:forward", query: "segmentId=19475&direction=forward&lon=-104.87663973610584&lat=38.801166000803974" },
  { name: "downtown 9270:forward", query: "segmentId=9270&direction=forward&lon=-104.81840068792545&lat=38.82764673638745" },
];

export interface Answer {
  label: string;
  ms: number;
  status: number;
  edge: string | null;
  bytes: number;
  reused: boolean;
  serverTiming: string | null;
  body: string;
}

export interface Run {
  builtAtBefore: string | null;
  builtAtAfter: string | null;
  firsts: Answer[];
  warm: Answer[];
  quiet: Answer[];
}

export interface Options {
  quietMs: number;
  quietSamples: number;
  warmRuns: number;
  presses: ReadonlyArray<{ name: string; query: string }>;
}

const DEFAULTS: Options = { quietMs: 40_000, quietSamples: 3, warmRuns: 3, presses: PRESSES };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// The verdict, as the failures it found: none is a pass.
export function judge(run: Run, budget: { warmMedianMs: number; quietEachMs: number } = BUDGET): string[] {
  const failures: string[] = [];
  if (run.builtAtBefore === null || run.builtAtAfter === null) failures.push("/health did not answer 200 with a builtAt");
  else if (run.builtAtBefore !== run.builtAtAfter) {
    failures.push(`builtAt moved from ${run.builtAtBefore} to ${run.builtAtAfter} during the run: a deploy happened, the numbers mean nothing`);
  }
  for (const answer of [...run.firsts, ...run.warm, ...run.quiet]) {
    if (answer.status !== 200) failures.push(`${answer.label} answered HTTP ${answer.status}`);
  }
  if (run.warm.length === 0) failures.push("no warm press was measured");
  else if (median(run.warm.map((a) => a.ms)) > budget.warmMedianMs) {
    failures.push(`warm median ${median(run.warm.map((a) => a.ms)).toFixed(0)}ms is over ${budget.warmMedianMs}ms`);
  }
  if (run.quiet.length === 0) failures.push("no press after quiet was measured");
  for (const answer of run.quiet) {
    if (answer.ms > budget.quietEachMs) failures.push(`${answer.label} took ${answer.ms.toFixed(0)}ms, over ${budget.quietEachMs}ms`);
  }
  return failures;
}

// Server-Timing as the server's trace writes it: name;dur=ms entries, and the
// pool's desc in quotes. A quoted value holding a semicolon is not split
// correctly; the server never sends one.
export function parseServerTiming(header: string): Array<{ name: string; dur?: number; desc?: string }> {
  return header.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((entry) => {
    const [name = "", ...params] = entry.trim().split(";");
    const metric: { name: string; dur?: number; desc?: string } = { name: name.trim() };
    for (const param of params) {
      const at = param.indexOf("=");
      const key = param.slice(0, at).trim();
      const value = param.slice(at + 1).trim().replace(/^"(.*)"$/, "$1");
      if (key === "dur") metric.dur = Number(value);
      if (key === "desc") metric.desc = value;
    }
    return metric;
  });
}

// "server 263ms before the answer: network 120, rideOrder 98, ...; idle 4 of 4 waiting 0 opened 0"
export function describeServerTiming(header: string | null): string {
  if (header === null) return "no Server-Timing";
  const metrics = parseServerTiming(header);
  const total = metrics.find((m) => m.name === "total");
  const stages = metrics.filter((m) => m.dur !== undefined && m.name !== "total");
  const pool = metrics.find((m) => m.name === "pool");
  return (
    `server ${total?.dur?.toFixed(0) ?? "?"}ms before the answer: ` +
    stages.map((m) => `${m.name} ${m.dur!.toFixed(0)}`).join(", ") +
    (pool?.desc ? `; ${pool.desc}` : "")
  );
}

export async function measure(base: string, options: Options = DEFAULTS, log: (line: string) => void = () => undefined): Promise<Run> {
  const secure = new URL(base).protocol === "https:";
  const agent = secure ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
  const get = (label: string, path: string): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const t0 = performance.now();
      const req = (secure ? https : http).get(`${base}${path}`, { agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            label,
            ms: performance.now() - t0,
            status: res.statusCode ?? 0,
            edge: (res.headers["x-railway-edge"] as string | undefined) ?? null,
            bytes: body.length,
            reused: req.reusedSocket,
            serverTiming: (res.headers["server-timing"] as string | undefined) ?? null,
            body: body.toString("utf8"),
          });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(30_000, () => req.destroy(new Error(`${label} timed out after 30s`)));
    });
  const builtAt = async (): Promise<string | null> => {
    const health = await get("/health", "/health");
    if (health.status !== 200) return null;
    return (JSON.parse(health.body) as { builtAt?: string }).builtAt ?? null;
  };
  const show = (a: Answer) =>
    `${a.label}: ${a.ms.toFixed(0)}ms, HTTP ${a.status}, ${(a.bytes / 1024).toFixed(0)}KB, connection ${a.reused ? "reused" : "new"}; ${describeServerTiming(a.serverTiming)}`;

  try {
    const builtAtBefore = await builtAt();
    const health = [await get("/health", "/health"), await get("/health", "/health"), await get("/health", "/health")];
    log(`eval:latency against ${base}, builtAt ${builtAtBefore}, edge ${health[0]!.edge}`);
    log(`/health (no database): ${health.map((h) => `${h.ms.toFixed(0)}ms`).join(", ")}\n`);

    const run: Run = { builtAtBefore, builtAtAfter: null, firsts: [], warm: [], quiet: [] };
    for (const press of options.presses) {
      const first = await get(`${press.name} first`, `/segments/path?${press.query}`);
      run.firsts.push(first);
      log(show(first));
      for (let i = 1; i <= options.warmRuns; i++) {
        const answer = await get(`${press.name} warm ${i}`, `/segments/path?${press.query}`);
        run.warm.push(answer);
        log(show(answer));
      }
    }
    const quietPress = options.presses[0]!;
    for (let i = 1; i <= options.quietSamples; i++) {
      await sleep(options.quietMs);
      const answer = await get(`${quietPress.name} after ${options.quietMs / 1000}s quiet, ${i}`, `/segments/path?${quietPress.query}`);
      run.quiet.push(answer);
      log(show(answer));
    }
    run.builtAtAfter = await builtAt();
    return run;
  } finally {
    agent.destroy();
  }
}

async function main(): Promise<boolean> {
  const base = process.env.API_BASE_URL ?? "https://cyclingdataapp-backend-production.up.railway.app";
  const run = await measure(base, DEFAULTS, (line) => console.log(line));
  const failures = judge(run);
  const warm = run.warm.map((a) => a.ms);
  const quiet = run.quiet.map((a) => a.ms);
  console.log(
    `\nwarm median ${warm.length > 0 ? median(warm).toFixed(0) : "(none)"}ms (budget ${BUDGET.warmMedianMs}), after quiet ` +
      `${quiet.map((ms) => ms.toFixed(0)).join(", ")}ms (budget ${BUDGET.quietEachMs} for each)`,
  );
  for (const failure of failures) console.log(`FAIL: ${failure}`);
  console.log(failures.length === 0 ? "PASS" : "FAIL");
  return failures.length === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (pass) => process.exit(pass ? 0 : 1),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
