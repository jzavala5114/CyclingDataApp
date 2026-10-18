// npm run eval:latency
//
// How long the deployed backend takes to answer a press, end to end from
// wherever this runs, as the phone asks: warm (back to back) and after 40s of
// quiet, longer than the database pool's old 30s idle timeout. GET only:
// /health, then GET /segments/path. Never run it while a deploy is rolling out
// (context/session.md, "Never send traffic to a deploying container"): it
// checks /health's builtAt before and after, and fails if it moved.
//
// The budget, set 2026-10-18 before the fix (the lag: measured from the
// access log, a press took a median 1170ms on the server warm and 2840ms
// after 30s or more of quiet, with the backend in Amsterdam and its database
// in Oregon): from this PC, warm median at most 1000ms, after 40s quiet at
// most 1200ms. The server's own time is in the access log (railway logs
// --deployment), where the budget is 500ms warm and 600ms after quiet.
const BASE = process.env.API_BASE_URL ?? "https://cyclingdataapp-backend-production.up.railway.app";
const WARM_BUDGET_MS = 1000;
const QUIET_BUDGET_MS = 1200;
const QUIET_MS = 40_000;
const WARM_RUNS = 3;

// Real presses, from the access log and eval:selection: a trail and downtown.
const PRESSES = [
  { name: "trails 19475:forward", query: "segmentId=19475&direction=forward&lon=-104.87663973610584&lat=38.801166000803974" },
  { name: "downtown 9270:forward", query: "segmentId=9270&direction=forward&lon=-104.81840068792545&lat=38.82764673638745" },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function timed(path: string): Promise<{ ms: number; status: number; edge: string | null; bytes: number }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`);
  const body = await res.text();
  return { ms: performance.now() - t0, status: res.status, edge: res.headers.get("x-railway-edge"), bytes: body.length };
}

async function builtAt(): Promise<string> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`/health answered ${res.status}`);
  return ((await res.json()) as { builtAt: string }).builtAt;
}

async function main() {
  const before = await builtAt();
  const health = [await timed("/health"), await timed("/health"), await timed("/health")];
  console.log(`eval:latency against ${BASE}, builtAt ${before}, edge ${health[0]!.edge}`);
  console.log(`/health (no database): ${health.map((h) => `${h.ms.toFixed(0)}ms`).join(", ")}\n`);

  const warm: number[] = [];
  for (const press of PRESSES) {
    const first = await timed(`/segments/path?${press.query}`);
    if (first.status !== 200) throw new Error(`${press.name}: HTTP ${first.status}`);
    const runs: number[] = [];
    for (let i = 0; i < WARM_RUNS; i++) runs.push((await timed(`/segments/path?${press.query}`)).ms);
    warm.push(...runs);
    console.log(`${press.name}: first ${first.ms.toFixed(0)}ms, then ${runs.map((m) => `${m.toFixed(0)}ms`).join(", ")} (${(first.bytes / 1024).toFixed(0)}KB)`);
  }

  console.log(`\n${QUIET_MS / 1000}s of quiet...`);
  await sleep(QUIET_MS);
  const quiet = await timed(`/segments/path?${PRESSES[0]!.query}`);
  console.log(`${PRESSES[0]!.name} after ${QUIET_MS / 1000}s quiet: ${quiet.ms.toFixed(0)}ms`);

  const after = await builtAt();
  if (after !== before) throw new Error(`builtAt moved from ${before} to ${after} during the run: a deploy happened, the numbers mean nothing`);

  const warmMedian = median(warm);
  const pass = warmMedian <= WARM_BUDGET_MS && quiet.ms <= QUIET_BUDGET_MS;
  console.log(`\nwarm median ${warmMedian.toFixed(0)}ms (budget ${WARM_BUDGET_MS}), after quiet ${quiet.ms.toFixed(0)}ms (budget ${QUIET_BUDGET_MS})`);
  console.log(pass ? "PASS" : "FAIL");
  return pass;
}

main().then(
  (pass) => process.exit(pass ? 0 : 1),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
