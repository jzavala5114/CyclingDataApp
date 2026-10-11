import "dotenv/config";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { loadSessionVerdicts, isUsable } from "../services/usableSessions.js";
import { SHIPPED_GATE, type GateThresholds } from "../services/elevationAggregator.js";
import { RETRACE_M } from "../services/segmentPasses.js";
import {
  loadRideContext,
  traceSession,
  witnessFloorFrom,
  type DrawnRun,
  type PassRecord,
} from "./traceOutAndBack.js";
import {
  byVerdict,
  evidenceFor,
  witnessDisagreements,
  type LineEvidence,
  type SessionBuf,
  type Verdict,
} from "./enumerateHeadingLines.js";
import type { Segment, SessionSample } from "../types/index.js";

// Should the traversal gate be looser? Swept with a witness that can see it.
//
// The gate (`qualifiesAt`) draws a run when it covers MIN_SPAN_M = 25m of its
// segment or MIN_COVERAGE = 0.7 of it. Loosening it would draw ground a rider
// covered in short pieces, and would also draw touches: crossing a street at an
// intersection, waiting beside one. The 2026-10-04 sweep could not tell the two
// apart, because its witness, `findPasses`, reported nothing under 25m, and every
// run a looser gate admits is under 25m or under 0.7 by construction. Here the
// witness runs at RETRACE_M = 15m, its own floor, while each arm sets only the
// gate, so the witness never moves with the thing being swept.
//
// Each arm is read against the shipped gate, twice:
//   RUNS it admits that the shipped gate does not, each one
//     witnessed     a pass on that segment, that way, overlaps the run in time
//     denied        the run spans the floor and no pass overlaps it: a touch
//     unjudgeable   the run spans less than the floor, so silence proves nothing
//   LINES it draws that no ride draws under the shipped gate, with
//   `eval:heading-lines`' verdicts: real ground, next door, phantom, no
//   witness. A run on a line already drawn changes the map far less than a
//   line that appears, so this is the table that says what the map gains.
//
// Read-only. Every query is a select.
//
//   npm run eval:gate
//   npm run eval:gate -- 25/0.7,18/0.7,22/0.5 --witness 15
//   npm run eval:gate -- --lines        # name every new line

const DEFAULT_GATES = "22/0.7,20/0.7,18/0.7,15/0.7,25/0.5,22/0.5";

/** `span/cover` pairs, with the shipped gate always first, because every arm is
 * read against it and a sweep without it would compare against nothing. */
export function parseGates(arg: string | undefined): GateThresholds[] {
  const gates = (arg ?? DEFAULT_GATES).split(",").map((pair) => {
    const parts = pair.split("/");
    const [span, cover] = parts.map(Number);
    // Number("") is 0, a real threshold, so an empty half must not slip through.
    if (parts.length !== 2 || parts.some((p) => p.trim() === "") || !(span! >= 0) || !(cover! >= 0 && cover! <= 1)) {
      throw new Error(`gates are span/cover pairs such as 18/0.7, cover from 0 to 1; got "${pair}"`);
    }
    return { minSpanM: span!, minCoverage: cover! };
  });
  const shipped = (g: GateThresholds) =>
    g.minSpanM === SHIPPED_GATE.minSpanM && g.minCoverage === SHIPPED_GATE.minCoverage;
  return [SHIPPED_GATE, ...gates.filter((g) => !shipped(g))];
}

export const gateLabel = (g: GateThresholds) => `${g.minSpanM}/${g.minCoverage}`;

/** Runs an arm draws that the shipped gate does not. The matcher is the same
 * under every arm, so a run is the same run in both and identity is exact. */
export function admittedRuns(shipped: readonly DrawnRun[], arm: readonly DrawnRun[]): DrawnRun[] {
  const id = (r: DrawnRun) => `${r.sessionId}|${r.segmentId}|${r.direction}|${r.startedMs}|${r.endedMs}`;
  const before = new Set(shipped.map(id));
  return arm.filter((r) => !before.has(id(r)));
}

export type RunVerdict = "witnessed" | "denied" | "unjudgeable";

/**
 * One admitted run, judged by the bearing-free witness alone.
 *
 * A pass that overlaps it is evidence whatever the run's length. Without one,
 * the run's span decides whether the silence means anything: the witness
 * cannot report a pass shorter than its floor, so a run spanning less is
 * unjudgeable, not denied. That span is bracketed by the fixes either side
 * (see `bucketizeRun`) and the witness's is not, so a run just above the floor
 * can be a real crossing whose own fixes fell under it; the report counts those
 * separately rather than trusting them.
 */
export function judgeAdmitted(run: DrawnRun, passes: readonly PassRecord[], witnessM: number): RunVerdict {
  const seen = passes.some(
    (p) =>
      p.sessionId === run.sessionId &&
      p.segmentId === run.segmentId &&
      p.direction === run.direction &&
      p.startedMs <= run.endedMs &&
      run.startedMs <= p.endedMs,
  );
  if (seen) return "witnessed";
  return run.spanM < witnessM ? "unjudgeable" : "denied";
}

/** How much nearer the floor than this a denial is weak evidence. */
export const NEAR_FLOOR_M = 5;

interface Arm {
  gate: GateThresholds;
  merged: number;
  discarded: number;
  buckets: number;
  coveredM: number;
  drawn: Set<string>;
  runs: DrawnRun[];
  bufs: SessionBuf[];
  checked: number;
  disagreed: number;
}

const metres = (n: number) => Math.round(n);
const linesOf = (list: readonly LineEvidence[]) =>
  `${list.length} (${metres(list.reduce((n, e) => n + e.coveredM, 0))}m)`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const witnessAt = argv.indexOf("--witness");
  // The point of this script is a witness below the gate, so its default is
  // the lowest floor that runs, not the 25m the other evals default to.
  const witnessM = witnessAt === -1 ? RETRACE_M : witnessFloorFrom(argv);
  const positional = argv.find((a, i) => !a.startsWith("--") && (witnessAt === -1 || i !== witnessAt + 1));
  const gates = parseGates(positional);
  const listLines = argv.includes("--lines");

  const client = await pool.connect();
  await client.query("set statement_timeout = '15min'");
  const usable = (await loadSessionVerdicts(client)).filter(isUsable);
  console.log(
    `sweeping the traversal gate (span m / coverage) over ${usable.length} sessions: ` +
      `${gates.map(gateLabel).join(", ")}; shipped ${gateLabel(SHIPPED_GATE)}, witness floor ${witnessM}m\n`,
  );

  const arms: Arm[] = gates.map((gate) => ({
    gate, merged: 0, discarded: 0, buckets: 0, coveredM: 0,
    drawn: new Set(), runs: [], bufs: [], checked: 0, disagreed: 0,
  }));
  const witness: PassRecord[] = [];
  const lengths = new Map<number, number>();
  const meta = new Map<number, Pick<Segment, "streetName" | "kind" | "lengthM">>();
  let done = 0;

  for (const session of usable) {
    // Read once, replay once per arm: the query is the slow part.
    const { samples, segments } = await loadRideContext(client, session.id);
    if (!samples.length) continue;
    for (const s of segments) {
      lengths.set(s.id, s.lengthM);
      meta.set(s.id, { streetName: s.streetName, kind: s.kind, lengthM: s.lengthM });
    }
    const fixTimes = (samples as SessionSample[]).map((s) => ({
      id: s.id,
      atMs: Date.parse(s.recordedAt as unknown as string),
    }));
    const traces = gates.map((gate) =>
      traceSession(session.id, samples, segments, { minPassM: witnessM, gate }),
    );
    const base = traces[0]!;
    witness.push(...base.passes);
    traces.forEach((t, k) => {
      const arm = arms[k]!;
      arm.merged += t.merged;
      arm.discarded += t.discarded;
      arm.buckets += t.buckets;
      arm.coveredM += t.coveredM;
      for (const d of t.drawn) arm.drawn.add(d);
      arm.runs.push(...t.runs);
      const w = witnessDisagreements(base.passes, t.passes);
      arm.checked += w.checked;
      arm.disagreed += w.disagreed;
      arm.bufs.push({
        sessionId: session.id,
        fixTimes,
        device: { drawn: base.drawn, runs: base.runs, passes: base.passes, drawnFix: base.drawnFix },
        derived: { drawn: t.drawn, runs: t.runs, passes: t.passes, drawnFix: t.drawnFix },
      });
    });
    done++;
    if (done % 10 === 0) console.log(`  ${done}/${usable.length} sessions`);
  }

  const shipped = arms[0]!;
  const disagreed = arms.reduce((n, a) => n + a.disagreed, 0);
  console.log(`\nCONTROL -- the witness does not move with the gate`);
  console.log(
    `  ${arms.reduce((n, a) => n + a.checked, 0)} pass comparisons, ${disagreed} disagreements` +
      (disagreed === 0 ? "   OK" : "   FAIL: every verdict below is circular"),
  );
  // A looser gate admits a superset of runs, so it can never draw less. If one
  // does, the arms are not being replayed the same way and nothing below holds.
  const looser = arms.slice(1).filter(
    (a) => a.gate.minSpanM <= SHIPPED_GATE.minSpanM && a.gate.minCoverage <= SHIPPED_GATE.minCoverage,
  );
  const shrank = looser.filter(
    (a) => [...shipped.drawn].some((d) => !a.drawn.has(d)) || admittedRuns(a.runs, shipped.runs).length > 0,
  );
  console.log(
    `CONTROL -- no looser arm draws less than the shipped gate: ` +
      (shrank.length === 0 ? `${looser.length} arms   OK` : `FAIL: ${shrank.map((a) => gateLabel(a.gate)).join(", ")}`),
  );

  console.log(`\nHEALTH, per arm`);
  console.table(
    arms.map((a) => ({
      gate: a === shipped ? `${gateLabel(a.gate)}  <- shipped` : gateLabel(a.gate),
      lines: a.drawn.size,
      merged: a.merged,
      discard: `${((100 * a.discarded) / Math.max(1, a.merged + a.discarded)).toFixed(1)}%`,
      buckets: a.buckets,
      covered_km: (a.coveredM / 1000).toFixed(2),
    })),
  );

  console.log(`\nRUNS each arm admits that the shipped gate rejects, judged by the witness`);
  console.table(
    arms.slice(1).map((a) => {
      const judged = admittedRuns(shipped.runs, a.runs).map((run) => ({
        run,
        verdict: judgeAdmitted(run, witness, witnessM),
      }));
      const of = (v: RunVerdict) => judged.filter((j) => j.verdict === v);
      const tally = (v: RunVerdict) =>
        `${of(v).length} (${metres(of(v).reduce((n, j) => n + j.run.coveredM, 0))}m)`;
      const denied = of("denied");
      return {
        gate: gateLabel(a.gate),
        admitted: judged.length,
        witnessed: tally("witnessed"),
        denied: tally("denied"),
        [`denied within ${NEAR_FLOOR_M}m of floor`]: denied.filter((j) => j.run.spanM < witnessM + NEAR_FLOOR_M).length,
        unjudgeable: tally("unjudgeable"),
        "denied per witnessed": of("witnessed").length ? (denied.length / of("witnessed").length).toFixed(2) : "-",
      };
    }),
  );

  console.log(`\nLINES each arm draws that no ride draws under the shipped gate`);
  const verdictsByArm = arms.slice(1).map((a) => ({
    arm: a,
    gained: evidenceFor(a.bufs, "derived", lengths, witnessM),
    lost: evidenceFor(a.bufs, "device", lengths, witnessM),
  }));
  console.table(
    verdictsByArm.map(({ arm, gained, lost }) => {
      const by = byVerdict(gained);
      const pick = (v: Verdict) => by.get(v) ?? [];
      const real = pick("real-loss").length;
      return {
        gate: gateLabel(arm.gate),
        "new lines": gained.size,
        "real ground": linesOf(pick("real-loss")),
        "next door": linesOf(pick("next-door")),
        phantom: linesOf(pick("phantom")),
        "no witness": linesOf(pick("no-witness")),
        "phantom per real": real ? (pick("phantom").length / real).toFixed(2) : "-",
        "lines lost": lost.size,
      };
    }),
  );

  if (listLines) {
    for (const { arm, gained } of verdictsByArm) {
      if (gained.size === 0) continue;
      console.log(`\n  ${gateLabel(arm.gate)}: new lines`);
      for (const [verdict, list] of byVerdict(gained)) {
        for (const e of list) {
          const id = Number(e.key.split("|")[0]);
          const m = meta.get(id);
          console.log(
            `    ${verdict.padEnd(10)} #${String(id).padStart(6)} ${e.key.split("|")[1]!.padEnd(8)} ` +
              `${(m?.streetName ?? m?.kind ?? "?").slice(0, 28).padEnd(28)} len ${String(Math.round(m?.lengthM ?? 0)).padStart(4)}m  ` +
              `drew ${String(metres(e.coveredM)).padStart(4)}m  s[${e.sessions.join(",")}]`,
          );
        }
      }
    }
  }

  console.log(
    `\nHow to read it. "real ground" is the gain: a pass whose fixes the shipped gate draws\n` +
      `nowhere. "phantom" is the cost: a line in a direction no pass ever made. "next door"\n` +
      `is ground already drawn on a neighbour. Blind spots: the witness cannot see under\n` +
      `${witnessM}m, so "unjudgeable" and "no witness" are not evidence either way; a denial within\n` +
      `${NEAR_FLOOR_M}m of the floor may be a real crossing whose own fixes fell under it, because the\n` +
      `gate's span is bracketed by the fixes either side and the witness's is not; and a\n` +
      `pass inside the corridor is not proof the rider was on THIS line rather than its\n` +
      `parallel neighbour, which "next door" exists to catch.`,
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
