import "dotenv/config";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { loadSessionVerdicts, isUsable } from "../services/usableSessions.js";
import { TANGENT_WINDOW_M } from "../services/segmentMatcher.js";
import { loadRideContext, traceSession, type SessionTrace } from "./traceOutAndBack.js";

// Does widening or narrowing the tangent window fix the backwards directions?
//
// 39 of the 63 genuinely-lost out-and-back passes are the matcher drawing the
// OTHER direction over the same ground at the same time, and almost all of them
// are on switchback trails. `TANGENT_WINDOW_M` is how far either side of a fix
// the matcher looks to decide which way the trail points; on a hairpin, 10m
// either side averages across the bend and the result points nowhere useful.
// So a smaller window should read hairpins better -- and a window too small is
// mostly digitising noise, which is why the constant exists at all.
//
// Sweeps that one number through the real matcher, via `traceSession`, and
// reports the direction errors alongside the health measures that a fix could
// quietly pay with: merged runs, discards, buckets, covered distance, drawn
// lines. A change that halves wrong-dir and loses 5km of coverage is not a fix.
//
// Read-only. Every query is a select.
//
//   npm run eval:tangent
//   npm run eval:tangent -- 0,5,10,20

const DEFAULT_WINDOWS = [0, 3, 5, 7, 10, 14, 20];

interface ArmTotals {
  windowM: number;
  wrongDir: number;
  wrongDirM: number;
  gate: number;
  gateM: number;
  nextDoor: number;
  noRun: number;
  dropped: number;
  bothWays: number;
  bothWaysDrawn: number;
  merged: number;
  discarded: number;
  buckets: number;
  coveredM: number;
  drawn: Set<string>;
}

const blank = (windowM: number): ArmTotals => ({
  windowM,
  wrongDir: 0, wrongDirM: 0, gate: 0, gateM: 0,
  nextDoor: 0, noRun: 0, dropped: 0,
  bothWays: 0, bothWaysDrawn: 0,
  merged: 0, discarded: 0, buckets: 0, coveredM: 0,
  drawn: new Set(),
});

function add(t: ArmTotals, trace: SessionTrace): void {
  for (const l of trace.losses) {
    if (l.cause === "wrong-dir") { t.wrongDir++; t.wrongDirM += l.pass.spanM; }
    else if (l.cause === "gate") { t.gate++; t.gateM += l.pass.spanM; }
    else if (l.cause === "next-door") t.nextDoor++;
    else if (l.cause === "no-run") t.noRun++;
    else t.dropped++;
  }
  t.bothWays += trace.bothWays;
  t.bothWaysDrawn += trace.bothWaysDrawn;
  t.merged += trace.merged;
  t.discarded += trace.discarded;
  t.buckets += trace.buckets;
  t.coveredM += trace.coveredM;
  for (const d of trace.drawn) t.drawn.add(d);
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const windows = arg ? arg.split(",").map(Number) : DEFAULT_WINDOWS;
  if (windows.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new Error(`windows must be finite and non-negative, got ${arg}`);
  }

  const client = await pool.connect();
  await client.query("set statement_timeout = '15min'");
  const usable = (await loadSessionVerdicts(client)).filter(isUsable);
  console.log(
    `sweeping tangent window ${windows.join(", ")}m over ${usable.length} sessions ` +
      `(shipped: ${TANGENT_WINDOW_M}m, 0 means the straight-line chord)\n`,
  );

  const totals = new Map(windows.map((w) => [w, blank(w)]));
  let done = 0;
  for (const session of usable) {
    const sessionId = session.id;
    // Read once, replay once per arm: the query is the slow part and the arms
    // differ only in a matcher option.
    const { samples, segments } = await loadRideContext(client, sessionId);
    if (!samples.length) continue;
    for (const windowM of windows) {
      add(totals.get(windowM)!, traceSession(sessionId, samples, segments, {
        matcher: { tangentWindowM: windowM },
      }));
    }
    done++;
    if (done % 10 === 0) console.log(`  ${done}/${usable.length} sessions`);
  }

  const rows = windows.map((w) => {
    const t = totals.get(w)!;
    return {
      window: w === TANGENT_WINDOW_M ? `${w}m  <- shipped` : `${w}m`,
      "wrong-dir": `${t.wrongDir} (${t.wrongDirM.toFixed(0)}m)`,
      gate: `${t.gate} (${t.gateM.toFixed(0)}m)`,
      "both drawn": `${t.bothWaysDrawn}/${t.bothWays}`,
      merged: t.merged,
      discard: `${((100 * t.discarded) / Math.max(1, t.merged + t.discarded)).toFixed(1)}%`,
      buckets: t.buckets,
      covered_km: (t.coveredM / 1000).toFixed(2),
      lines: t.drawn.size,
    };
  });
  console.log();
  console.table(rows);

  // What the shipped setting draws that an arm does not, and the reverse. A net
  // line count that holds still can hide an even swap.
  const base = totals.get(TANGENT_WINDOW_M);
  if (base) {
    console.log(`\nlines gained and lost against the shipped ${TANGENT_WINDOW_M}m:`);
    for (const w of windows) {
      if (w === TANGENT_WINDOW_M) continue;
      const t = totals.get(w)!;
      const gained = [...t.drawn].filter((d) => !base.drawn.has(d)).length;
      const lost = [...base.drawn].filter((d) => !t.drawn.has(d)).length;
      console.log(`  ${String(w).padStart(3)}m  +${String(gained).padStart(3)} / -${String(lost).padStart(3)}  net ${gained - lost >= 0 ? "+" : ""}${gained - lost}`);
    }
  }

  console.log(
    `\nBlind spot: the pass detector is the same under every arm, so this compares ` +
      `arms fairly\nbut inherits the detector's own generosity on braided trails. ` +
      `wrong-dir and gate are the\ncolumns to read; next-door is not a defect.`,
  );

  client.release();
  await pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
