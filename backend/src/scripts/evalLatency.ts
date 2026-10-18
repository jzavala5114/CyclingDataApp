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
// phone does not. Each quiet sample says whether the connection was reused.
//
// The budget, set 2026-10-18 before the fix (the lag: measured from the
// access log, a press took a median 1170ms on the server warm and 2840ms
// after 30s or more of quiet, with the backend in Amsterdam and its database
// in Oregon): from this PC, warm median at most 1000ms, and the median of
// three presses each after 40s of quiet at most 1200ms. The server's own time
// is in the access log (railway logs --deployment), where the budget is 500ms
// warm and 600ms after quiet.
import https from "node:https";

const BASE = process.env.API_BASE_URL ?? "https://cyclingdataapp-backend-production.up.railway.app";
const WARM_BUDGET_MS = 1000;
const QUIET_BUDGET_MS = 1200;
const QUIET_MS = 40_000;
const QUIET_SAMPLES = 3;
const WARM_RUNS = 3;

// Real presses, from the access log and eval:selection: a trail and downtown.
const PRESSES = [
  { name: "trails 19475:forward", query: "segmentId=19475&direction=forward&lon=-104.87663973610584&lat=38.801166000803974" },
  { name: "downtown 9270:forward", query: "segmentId=9270&direction=forward&lon=-104.81840068792545&lat=38.82764673638745" },
];

const agent = new https.Agent({ keepAlive: true });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

interface Answer {
  ms: number;
  status: number;
  edge: string | null;
  body: string;
  reused: boolean;
}

function get(path: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = https.get(`${BASE}${path}`, { agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          ms: performance.now() - t0,
          status: res.statusCode ?? 0,
          edge: (res.headers["x-railway-edge"] as string | undefined) ?? null,
          body: Buffer.concat(chunks).toString("utf8"),
          reused: req.reusedSocket,
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${path.slice(0, 60)} timed out after 30s`)));
  });
}

async function builtAt(): Promise<string> {
  const health = await get("/health");
  if (health.status !== 200) throw new Error(`/health answered ${health.status}`);
  return (JSON.parse(health.body) as { builtAt: string }).builtAt;
}

async function main() {
  const before = await builtAt();
  const health = [await get("/health"), await get("/health"), await get("/health")];
  console.log(`eval:latency against ${BASE}, builtAt ${before}, edge ${health[0]!.edge}`);
  console.log(`/health (no database): ${health.map((h) => `${h.ms.toFixed(0)}ms`).join(", ")}\n`);

  const warm: number[] = [];
  for (const press of PRESSES) {
    const first = await get(`/segments/path?${press.query}`);
    if (first.status !== 200) throw new Error(`${press.name}: HTTP ${first.status}`);
    const runs: number[] = [];
    for (let i = 0; i < WARM_RUNS; i++) runs.push((await get(`/segments/path?${press.query}`)).ms);
    warm.push(...runs);
    console.log(`${press.name}: first ${first.ms.toFixed(0)}ms, then ${runs.map((m) => `${m.toFixed(0)}ms`).join(", ")} (${(first.body.length / 1024).toFixed(0)}KB)`);
  }

  const quiet: number[] = [];
  for (let i = 0; i < QUIET_SAMPLES; i++) {
    await sleep(QUIET_MS);
    const answer = await get(`/segments/path?${PRESSES[0]!.query}`);
    if (answer.status !== 200) throw new Error(`after quiet: HTTP ${answer.status}`);
    quiet.push(answer.ms);
    console.log(`${PRESSES[0]!.name} after ${QUIET_MS / 1000}s quiet: ${answer.ms.toFixed(0)}ms (connection ${answer.reused ? "reused" : "new"})`);
  }

  const after = await builtAt();
  if (after !== before) throw new Error(`builtAt moved from ${before} to ${after} during the run: a deploy happened, the numbers mean nothing`);

  const warmMedian = median(warm);
  const quietMedian = median(quiet);
  const pass = warmMedian <= WARM_BUDGET_MS && quietMedian <= QUIET_BUDGET_MS;
  console.log(
    `\nwarm median ${warmMedian.toFixed(0)}ms (budget ${WARM_BUDGET_MS}), after quiet median ${quietMedian.toFixed(0)}ms, ` +
      `slowest ${Math.max(...quiet).toFixed(0)}ms (budget ${QUIET_BUDGET_MS} for the median)`,
  );
  console.log(pass ? "PASS" : "FAIL");
  agent.destroy();
  return pass;
}

main().then(
  (pass) => process.exit(pass ? 0 : 1),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
