// Mutation harness for the barometer decision logic.
//
// Written from scratch because variant A's harness reported 23 of 23 mutants
// SURVIVED, which is not a test-coverage result, it is a harness that never
// applied a mutation. So this one REFUSES to run a mutant whose replacement did
// not change the file, and prints NOT-APPLIED rather than quietly scoring it.
//
//   cd mobile && npm run mutate:barometer

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const WINDOW = "src/services/barometerWindow.ts";
const HEALTH = "src/services/barometerHealth.ts";

const mutants = [
  // --- the window itself ---
  [WINDOW, "drop Math.abs, so every older reading passes",
    "if (Math.abs(reading.atMs - fixAtMs) <= halfWindowMs) kept.push(reading);",
    "if ((reading.atMs - fixAtMs) <= halfWindowMs) kept.push(reading);"],
  [WINDOW, "window edge exclusive instead of inclusive",
    "if (Math.abs(reading.atMs - fixAtMs) <= halfWindowMs) kept.push(reading);",
    "if (Math.abs(reading.atMs - fixAtMs) < halfWindowMs) kept.push(reading);"],
  [WINDOW, "half window 500 -> 1000, so neighbouring fixes share readings",
    "export const DEFAULT_HALF_WINDOW_MS = 500;",
    "export const DEFAULT_HALF_WINDOW_MS = 1000;"],
  [WINDOW, "drop the Array.isArray guard",
    "  if (!Array.isArray(readings)) return [];",
    "  // guard removed"],
  [WINDOW, "drop the clamp on a caller-supplied half window",
    "  return Math.min(requested, MAX_HALF_WINDOW_MS);",
    "  return requested;"],
  [WINDOW, "honour a half window of exactly zero",
    "  if (requested == null || !Number.isFinite(requested) || requested <= 0) {",
    "  if (requested == null || !Number.isFinite(requested) || requested < 0) {"],

  // --- the no-regression door ---
  [WINDOW, "remove the empty-window null return",
    "  if (inWindow.length === 0) return null;",
    "  if (false) return null;"],

  // --- what counts as a reading ---
  [WINDOW, "accept any pressure, dropping the plausibility band",
    "  return reading.hPa >= MIN_PLAUSIBLE_HPA && reading.hPa <= MAX_PLAUSIBLE_HPA;",
    "  return true;"],
  [WINDOW, "drop the finiteness check on hPa, so one NaN poisons the mean",
    "  if (!Number.isFinite(reading.hPa)) return false;",
    "  // check removed"],
  [WINDOW, "drop the finiteness check on atMs",
    "  if (!Number.isFinite(reading.atMs)) return false;",
    "  // check removed"],

  // --- the formula ---
  [WINDOW, "sea level 1013.25 -> 1013.0", "export const SEA_LEVEL_HPA = 1013.25;",
    "export const SEA_LEVEL_HPA = 1013.0;"],
  [WINDOW, "exponent 1/5.255 -> 1/5.25",
    "  return 44330 * (1 - Math.pow(pressureHpa / SEA_LEVEL_HPA, 1 / 5.255));",
    "  return 44330 * (1 - Math.pow(pressureHpa / SEA_LEVEL_HPA, 1 / 5.25));"],
  [WINDOW, "scale 44330 -> 44300",
    "  return 44330 * (1 - Math.pow(pressureHpa / SEA_LEVEL_HPA, 1 / 5.255));",
    "  return 44300 * (1 - Math.pow(pressureHpa / SEA_LEVEL_HPA, 1 / 5.255));"],

  // --- the reported offset ---
  [WINDOW, "flip the offset sign", "    offsetSum += reading.atMs - fixAtMs;",
    "    offsetSum += fixAtMs - reading.atMs;"],
  [WINDOW, "report the offset SUM rather than the mean",
    "    meanOffsetMs: offsetSum / readingCount,", "    meanOffsetMs: offsetSum,"],

  // --- the bridge decoder ---
  [WINDOW, "decode length as pair count, pairing the back half with undefined",
    "  const pairs = flat.length >>> 1;", "  const pairs = flat.length;"],
  [WINDOW, "swap atMs and hPa when decoding",
    "    readings[i] = { atMs: flat[i * 2] as number, hPa: flat[i * 2 + 1] as number };",
    "    readings[i] = { atMs: flat[i * 2 + 1] as number, hPa: flat[i * 2] as number };"],

  // --- the status line ---
  [HEALTH, "healthy rate 2.5 -> 1.0", "export const HEALTHY_HZ = 2.5;",
    "export const HEALTHY_HZ = 1.0;"],
  [HEALTH, "healthy used share 0.8 -> 0.1", "export const HEALTHY_USED_SHARE = 0.8;",
    "export const HEALTHY_USED_SHARE = 0.1;"],
  [HEALTH, "slow boundary inclusive",
    '  return health.hz != null && health.hz < HEALTHY_HZ ? "slow" : "good";',
    '  return health.hz != null && health.hz <= HEALTHY_HZ ? "slow" : "good";'],
  [HEALTH, "patchy boundary flipped",
    '  if (health.usedShare < HEALTHY_USED_SHARE) return "patchy";',
    '  if (health.usedShare > HEALTHY_USED_SHARE) return "patchy";'],
  [HEALTH, "a zero used share no longer reads as silence",
    '  if (health.usedShare === 0) return "silent";',
    '  if (health.usedShare < 0) return "silent";'],
  [HEALTH, "an unregistered sensor no longer reads as offline",
    '  if (!health.registered) return "offline";',
    '  if (false) return "offline";'],
  [HEALTH, "no fixes yet reads as silence rather than good",
    '    return health.hz != null && health.hz <= 0 ? "silent" : "good";',
    '    return "silent";'],
  [HEALTH, "repaired timestamps no longer degrade the verdict",
    '  if (health.repaired != null && health.repaired > 0) return "degraded";',
    '  if (false) return "degraded";'],

  // --- the watchdog, which is the fix for the worst defect the review found ---
  [HEALTH, "WATCHDOG: every -> some, so one gps fix abandons the native path",
    "  return recentSources.every((source) => source !== \"barometer\");",
    "  return recentSources.some((source) => source !== \"barometer\");"],
  [HEALTH, "WATCHDOG: drop the grace period, convicting before any fix arrives",
    "  if (!(elapsedMs >= NATIVE_PROVE_ITSELF_MS)) return false;",
    "  // grace period removed"],
  [HEALTH, "WATCHDOG: drop the minimum-evidence rule",
    "  if (recentSources.length < MIN_FIXES_TO_JUDGE) return false;",
    "  // minimum removed"],
  [HEALTH, "WATCHDOG: grace period 20s -> 0",
    "export const NATIVE_PROVE_ITSELF_MS = 20_000;",
    "export const NATIVE_PROVE_ITSELF_MS = 0;"],
  [HEALTH, "WATCHDOG: a NaN elapsed time now convicts",
    "  if (!(elapsedMs >= NATIVE_PROVE_ITSELF_MS)) return false;",
    "  if (elapsedMs < NATIVE_PROVE_ITSELF_MS) return false;"],
  [HEALTH, "the recent share counts gps as barometric",
    '  return recentSources.filter((source) => source === "barometer").length / recentSources.length;',
    '  return recentSources.filter((source) => source !== "barometer").length / recentSources.length;'],
  [HEALTH, "an empty recent window reports a share of zero rather than null",
    "  if (recentSources.length === 0) return null;",
    "  if (recentSources.length === 0) return 0;"],

  // --- EXPECTED SURVIVOR. The isFinite(fixAtMs) guard in readingsInWindow is
  //     redundant under the current SELECTION bound (`<= half` keeps), because
  //     every comparison against NaN is false and a NaN fix time already
  //     selects nothing. Deleting it leaves the suite green. It is kept because
  //     the same bound written as a REJECTION (`> half` skips) would admit
  //     EVERY reading instead, and that rewrite looks like a tidy-up. Listed
  //     here so a future run does not re-raise it as a finding.
  [WINDOW, "EXPECTED: drop the isFinite(fixAtMs) guard, redundant under <= ",
    "  if (!Number.isFinite(fixAtMs)) return [];",
    "  // guard removed"],

  // --- CONTROL. Changes a comment only. A suite that kills this is asserting
  //     on something it should not be able to see, and the run is invalid.
  [WINDOW, "CONTROL: comment text only, MUST SURVIVE",
    "// --- The bridge shape ------------------------------------------------------",
    "// --- The bridge shape (control mutation) ------------------------------------"],
];

const originals = new Map();
for (const [file] of mutants) {
  if (!originals.has(file)) originals.set(file, readFileSync(file, "utf8"));
}

function restore() {
  for (const [file, text] of originals) writeFileSync(file, text);
}

function testsPass() {
  try {
    execSync("npx tsx --test src/**/*.test.ts", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

if (!testsPass()) {
  console.error("BASELINE IS RED. Fix the suite before running mutations.");
  process.exit(1);
}
console.log("baseline green\n");

let killed = 0;
let survived = 0;
let notApplied = 0;
const problems = [];

for (const [file, name, from, to] of mutants) {
  const original = originals.get(file);
  if (!original.includes(from)) {
    console.log(`NOT-APPLIED  ${name}`);
    console.log(`             anchor not found in ${file}`);
    notApplied++;
    problems.push(name);
    continue;
  }
  const mutated = original.replace(from, to);
  if (mutated === original) {
    console.log(`NOT-APPLIED  ${name}  (replacement was a no-op)`);
    notApplied++;
    problems.push(name);
    continue;
  }
  // try/finally because the alternative leaves a deliberately broken source
  // file in the working tree if anything between the write and the restore
  // throws, and the next thing to run would be scoring a mutant by accident.
  let green;
  try {
    writeFileSync(file, mutated);
    green = testsPass();
  } finally {
    restore();
  }

  const isControl = name.startsWith("CONTROL");
  const isExpected = name.startsWith("EXPECTED");
  if (green) {
    survived++;
    console.log(`${isControl || isExpected ? "SURVIVED(ok)" : "SURVIVED    "}  ${name}`);
    if (!isControl && !isExpected) problems.push(name);
  } else {
    killed++;
    console.log(`killed       ${name}`);
    if (isControl) problems.push(`${name} -- the control was killed`);
    if (isExpected) problems.push(`${name} -- an expected survivor was killed, so it is no longer redundant: promote it out of the EXPECTED list`);
  }
}

restore();
console.log(`\nkilled ${killed}   survived ${survived}   not applied ${notApplied}`);
if (problems.length) {
  console.log(`\nNEEDS ATTENTION:`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`\nall non-control mutants killed, control survived.`);
