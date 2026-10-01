import "dotenv/config";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { loadSessionVerdicts, isUsable } from "../services/usableSessions.js";
import { deriveHeadings, MIN_DERIVE_M } from "../services/segmentMatcher.js";
import { loadRideContext, traceSession, type SessionTrace } from "./traceOutAndBack.js";
import type { SessionSample } from "../types/index.js";

// Is the phone's reported heading what gets the direction wrong?
//
// The matcher decides direction by comparing `sample.headingDeg` against the
// local tangent. `eval:tangent` cleared the tangent half: the 39 wrong-dir
// passes are flat at 36-41 for every window from 3m to 20m. That leaves the
// heading half -- the value the device reports, which on a switchback at
// walking pace is the least reliable number in the record.
//
// Two things are measured, and they answer different questions:
//
//   1. How far apart the two headings are, over every fix in the archive. This
//      says whether the device is wrong at all, independent of any matching.
//   2. The full trace under each, which says whether it MATTERS -- and what a
//      switch would cost in coverage, discards and drawn lines.
//
// Read-only. Every query is a select.
//
//   npm run eval:heading

interface ArmTotals {
  name: string;
  wrongDir: number;
  wrongDirM: number;
  gate: number;
  gateM: number;
  nextDoor: number;
  bothWays: number;
  bothWaysDrawn: number;
  merged: number;
  discarded: number;
  buckets: number;
  coveredM: number;
  drawn: Set<string>;
}

const blank = (name: string): ArmTotals => ({
  name, wrongDir: 0, wrongDirM: 0, gate: 0, gateM: 0, nextDoor: 0,
  bothWays: 0, bothWaysDrawn: 0, merged: 0, discarded: 0, buckets: 0, coveredM: 0,
  drawn: new Set(),
});

function add(t: ArmTotals, trace: SessionTrace): void {
  for (const l of trace.losses) {
    if (l.cause === "wrong-dir") { t.wrongDir++; t.wrongDirM += l.pass.spanM; }
    else if (l.cause === "gate") { t.gate++; t.gateM += l.pass.spanM; }
    else if (l.cause === "next-door") t.nextDoor++;
  }
  t.bothWays += trace.bothWays;
  t.bothWaysDrawn += trace.bothWaysDrawn;
  t.merged += trace.merged;
  t.discarded += trace.discarded;
  t.buckets += trace.buckets;
  t.coveredM += trace.coveredM;
  for (const d of trace.drawn) t.drawn.add(d);
}

/** Smallest angle between two bearings, 0..180. */
const delta = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

async function main(): Promise<void> {
  const client = await pool.connect();
  await client.query("set statement_timeout = '15min'");
  const usable = (await loadSessionVerdicts(client)).filter(isUsable);
  console.log(`comparing heading sources over ${usable.length} sessions\n`);

  const arms = new Map([
    ["device (shipped)", blank("device (shipped)")],
    ["derived", blank("derived")],
  ]);

  // Part 1: do the two headings even disagree?
  const deltas: number[] = [];
  let deviceNull = 0;
  let derivedNull = 0;
  let bothPresent = 0;
  let reversed = 0; // more than 90 degrees apart: the half that flips direction
  let totalFixes = 0;

  let done = 0;
  for (const session of usable) {
    const sessionId = Number(session.id);
    const { samples, segments } = await loadRideContext(client, sessionId);
    if (!samples.length) continue;

    const derived = deriveHeadings(samples as SessionSample[]);
    for (let i = 0; i < samples.length; i++) {
      totalFixes++;
      const d = samples[i]!.headingDeg;
      const r = derived[i];
      if (d == null || d < 0) deviceNull++;
      if (r == null) derivedNull++;
      if (d == null || d < 0 || r == null) continue;
      bothPresent++;
      const gap = delta(d, r);
      deltas.push(gap);
      if (gap > 90) reversed++;
    }

    add(arms.get("device (shipped)")!, traceSession(sessionId, samples, segments, {
      matcher: { headingSource: "device" },
    }));
    add(arms.get("derived")!, traceSession(sessionId, samples, segments, {
      matcher: { headingSource: "derived" },
    }));

    done++;
    if (done % 10 === 0) console.log(`  ${done}/${usable.length} sessions`);
  }

  deltas.sort((a, b) => a - b);
  const q = (p: number) => deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))] ?? NaN;
  console.log(`\nPART 1 -- do the two headings disagree? ${totalFixes} fixes.`);
  console.log(`  device reports nothing on  ${deviceNull} (${((100 * deviceNull) / totalFixes).toFixed(1)}%)`);
  console.log(`  derived is null on         ${derivedNull} (${((100 * derivedNull) / totalFixes).toFixed(1)}%)  (moved under ${MIN_DERIVE_M}m)`);
  console.log(`  both present on            ${bothPresent}`);
  console.log(
    `  angle between them: median ${q(0.5).toFixed(1)}deg  p75 ${q(0.75).toFixed(1)}deg  ` +
      `p90 ${q(0.9).toFixed(1)}deg  p99 ${q(0.99).toFixed(1)}deg`,
  );
  console.log(
    `  more than 90deg apart (the half that flips direction): ${reversed} ` +
      `(${((100 * reversed) / Math.max(1, bothPresent)).toFixed(2)}%)`,
  );

  console.log(`\nPART 2 -- does it matter?`);
  console.table(
    [...arms.values()].map((t) => ({
      heading: t.name,
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

  const device = arms.get("device (shipped)")!;
  const derivedArm = arms.get("derived")!;
  const gained = [...derivedArm.drawn].filter((d) => !device.drawn.has(d)).length;
  const lost = [...device.drawn].filter((d) => !derivedArm.drawn.has(d)).length;
  console.log(`\nlines against the shipped device heading: +${gained} / -${lost} (net ${gained - lost >= 0 ? "+" : ""}${gained - lost})`);

  console.log(
    `\nBlind spot: the pass detector is identical under both arms, so this is a fair ` +
      `comparison\nbut inherits its generosity on braided trails. Read wrong-dir and gate; ` +
      `next-door is not a defect.`,
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
