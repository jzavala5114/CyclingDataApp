import "dotenv/config";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { loadSessionVerdicts, isUsable } from "../services/usableSessions.js";
import { loadRideContext, traceSession, type SessionTrace } from "./traceOutAndBack.js";
import type { MatchOptions } from "../services/segmentMatcher.js";

// Does dropping a sideways GPS spike change the map, and in which direction?
//
// `diagnose-spikes` established the defect is real but small: 16 fixes across
// 42 rides sit nearer a different OSM way than the line between their
// neighbours implies, 0.054% of all fixes. What it could not say is whether
// those 16 fixes change anything drawn. One fix on the wrong street can seed a
// spurious run, or it can be absorbed by a run that was going to be right
// anyway.
//
// So this replays every ride through the real matcher under each rule and
// reports the same counters every other sweep in this directory reports, which
// is what makes them comparable. Read `wrong-dir` and `gate` as the defects,
// `lines` as the cost, and `buckets` / `covered_km` as the bill for dropping
// fixes: every dropped fix is an elevation reading the model no longer gets,
// so a rule that helps direction while flattening coverage is not a win.
//
// The `off` arm is the shipped behaviour and is the control: it must reproduce
// the numbers the other sweeps print, or the comparison is against a moving
// baseline.
//
// Read-only. Every query is a select.
//
//   npm run eval:spikes

interface ArmTotals {
  name: string;
  wrongDir: number;
  wrongDirM: number;
  gate: number;
  gateM: number;
  bothWays: number;
  bothWaysDrawn: number;
  merged: number;
  discarded: number;
  buckets: number;
  coveredM: number;
  drawn: Set<string>;
}

const blank = (name: string): ArmTotals => ({
  name, wrongDir: 0, wrongDirM: 0, gate: 0, gateM: 0,
  bothWays: 0, bothWaysDrawn: 0, merged: 0, discarded: 0, buckets: 0, coveredM: 0,
  drawn: new Set(),
});

function add(t: ArmTotals, trace: SessionTrace): void {
  for (const l of trace.losses) {
    if (l.cause === "wrong-dir") { t.wrongDir++; t.wrongDirM += l.pass.spanM; }
    else if (l.cause === "gate") { t.gate++; t.gateM += l.pass.spanM; }
  }
  t.bothWays += trace.bothWays;
  t.bothWaysDrawn += trace.bothWaysDrawn;
  t.merged += trace.merged;
  t.discarded += trace.discarded;
  t.buckets += trace.buckets;
  t.coveredM += trace.coveredM;
  for (const d of trace.drawn) t.drawn.add(d);
}

/**
 * The arms, in order of how much they throw away.
 *
 * The thresholds are the ones `diagnose-spikes` counted, so the spike count
 * for each row is already known and the only new information here is what it
 * buys. Nothing between 0.5 and 0.8 on the ratio: the diagnostic showed those
 * rows differing by a couple of dozen fixes out of 29,513, which this replay
 * cannot resolve.
 */
const AGGRESSIVE = { minCrossM: 8, crossToChord: 0.3 };
const CAUTIOUS = { minCrossM: 12, crossToChord: 0.5 };

const ARMS: Array<{ name: string; matcher: MatchOptions }> = [
  { name: "off (shipped)", matcher: { positionFilter: null } },
  { name: "cross 8m, ratio 0.3", matcher: { positionFilter: AGGRESSIVE } },
  { name: "cross 10m, ratio 0.5", matcher: { positionFilter: { minCrossM: 10, crossToChord: 0.5 } } },
  { name: "cross 12m, ratio 0.5", matcher: { positionFilter: CAUTIOUS } },
  { name: "cross 15m, ratio 0.5", matcher: { positionFilter: { minCrossM: 15, crossToChord: 0.5 } } },
  // The question the rows above cannot answer. The derived heading is the
  // change actually queued to ship, and it attacks the same counter: wrong-dir
  // 39 -> 23 on its own. If it already fixes the passes the position filter
  // fixes, the filter buys nothing on top of it and the whole feature is
  // redundant rather than merely small.
  { name: "derived heading only", matcher: { headingSource: "derived" } },
  { name: "derived + spikes 8/0.3", matcher: { headingSource: "derived", positionFilter: AGGRESSIVE } },
  { name: "derived + spikes 12/0.5", matcher: { headingSource: "derived", positionFilter: CAUTIOUS } },
];

async function main(): Promise<void> {
  const client = await pool.connect();
  await client.query("set statement_timeout = '30min'");
  const usable = (await loadSessionVerdicts(client)).filter(isUsable);
  console.log(`replaying ${usable.length} sessions under ${ARMS.length} rules\n`);

  const totals = new Map(ARMS.map((a) => [a.name, blank(a.name)]));
  let done = 0;

  for (const session of usable) {
    const sessionId = session.id;
    const { samples, segments } = await loadRideContext(client, sessionId);
    if (!samples.length) continue;
    for (const arm of ARMS) {
      add(totals.get(arm.name)!, traceSession(sessionId, samples, segments, { matcher: arm.matcher }));
    }
    done++;
    if (done % 10 === 0) console.log(`  ${done}/${usable.length} sessions`);
  }

  const base = totals.get("off (shipped)")!;
  console.table(
    [...totals.values()].map((t) => ({
      rule: t.name,
      "wrong-dir": `${t.wrongDir} (${t.wrongDirM.toFixed(0)}m)`,
      gate: `${t.gate} (${t.gateM.toFixed(0)}m)`,
      "both drawn": `${t.bothWaysDrawn}/${t.bothWays}`,
      merged: t.merged,
      discard: `${((100 * t.discarded) / Math.max(1, t.merged + t.discarded)).toFixed(1)}%`,
      buckets: t.buckets,
      covered_km: (t.coveredM / 1000).toFixed(2),
      lines: t.drawn.size,
    })),
  );

  console.log(`\nlines against the shipped arm:`);
  for (const t of totals.values()) {
    if (t === base) continue;
    const gained = [...t.drawn].filter((d) => !base.drawn.has(d));
    const lost = [...base.drawn].filter((d) => !t.drawn.has(d));
    const net = gained.length - lost.length;
    console.log(
      `  ${t.name.padEnd(22)} +${String(gained.length).padStart(2)} / ` +
        `-${String(lost.length).padStart(2)}  (net ${net >= 0 ? "+" : ""}${net})` +
        `  buckets ${t.buckets - base.buckets >= 0 ? "+" : ""}${t.buckets - base.buckets}` +
        `  covered ${((t.coveredM - base.coveredM) / 1000).toFixed(2)} km`,
    );
  }

  console.log(
    `\nThe control is the \`off\` row: 39 wrong-dir, 24 gate, 215/419 both drawn, 2228 merged,\n` +
      `18.4% discard, 14710 buckets, 225.10 km, 966 lines. Anything else there and this\n` +
      `comparison is against a baseline that moved.\n` +
      `Blind spot: the pass detector is the same under every arm, so this is a fair\n` +
      `comparison but inherits its generosity on braided trails. next-door is not a defect\n` +
      `and is deliberately not counted here.`,
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
