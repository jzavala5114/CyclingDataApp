import "dotenv/config";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { loadSessionVerdicts, isUsable } from "../services/usableSessions.js";
import {
  loadRideContext,
  traceSession,
  NEXT_DOOR_SHARE,
  type DrawnRun,
  type PassRecord,
} from "./traceOutAndBack.js";
import { MIN_PASS_M } from "../services/segmentPasses.js";
import type { Segment, SessionSample } from "../types/index.js";

// Name every line the derived heading would cost, and say which losses are real.
//
// `eval:heading` proved the device heading is what reads an out-and-back
// backwards: 410 fixes (1.42%) more than 90 degrees from the derived bearing,
// and switching cuts genuinely-lost passes 63 -> 35 and discards 18.4% ->
// 12.8%. It also reported the bill: 36 drawn lines lost, 26 gained, net -10.
//
// A net line count is no reason to ship or not to ship. A line the device drew
// that the rider never rode is a line that SHOULD go, and a line the rider did
// ride that stops being drawn is a regression. The count treats those two as
// the same event. This script separates them.
//
// The witness is `findPasses`, which reads the projected fixes and the clock
// and never a heading, so it is identical under both arms. Each lost line gets
// exactly one verdict:
//
//   no-witness   The segment is shorter than MIN_PASS_M, so no pass can ever
//                be found on it and silence proves nothing. The traversal gate
//                has a second door this detector does not (`spanM >=
//                MIN_SPAN_M || coverageFraction >= MIN_COVERAGE`), so a 10m
//                stub can be drawn but can never be witnessed. Judged on where
//                the drawn run's own fixes went instead, and reported apart
//                from the rest because it is weaker evidence.
//   phantom      The segment is long enough to witness and no pass was found
//                in that direction, in any session where the device drew it.
//                The device painted a direction the rider never made. Losing
//                it is a fix, not a cost.
//   next-door    A pass exists, and under the derived heading most of its
//                fixes are drawn on another line. The ride is still on the
//                map, on the neighbour. Correct consolidation.
//   real-loss    A pass exists and its fixes are drawn nowhere under the
//                derived heading. Ground the map had and would lose.
//
// The gained lines get the same treatment in reverse, because 26 new phantoms
// would be a bad trade however good the lost 36 look.
//
// Read-only. Every query is a select.
//
//   npm run eval:heading-lines
//   npm run eval:heading-lines -- --all        # list every line, not the top 25

export type Verdict = "no-witness" | "phantom" | "next-door" | "real-loss";

/** Where one pass's fixes ended up under the OTHER arm. */
export interface PassFate {
  pass: PassRecord;
  /** Fixes inside the pass's time window. */
  fixes: number;
  /** Of those, the share drawn in any qualifying run under the other arm. */
  share: number;
  /** Top destinations by fix count, for reading the verdict back. */
  top: Array<[string, number]>;
}

/** Everything needed to judge one line, with no reference to the matcher. */
export interface LineEvidence {
  /** `segmentId|direction`. */
  key: string;
  /** Sessions where the arm being judged drew this line. */
  sessions: number[];
  /** Metres of covered extent the arm drew, summed over those sessions. */
  coveredM: number;
  /** The segment's mapped length, which bounds what a pass could ever span.
   * Unknown reads as 0, so a caller that forgets the lengths gets every line
   * marked unjudged rather than quietly credited as a phantom. */
  lengthM: number;
  /** Passes on this exact segment+direction, in those sessions only. */
  fates: PassFate[];
  /**
   * The same question asked of the DRAWN RUN's own time window rather than a
   * pass's. Weaker evidence -- a run window is where the matcher decided the
   * rider was, which is the thing under test -- so it is only consulted for
   * lines too short to witness, where the alternative is no evidence at all.
   */
  runFates: PassFate[];
}

/**
 * One line's verdict.
 *
 * Silence from the witness only means something when the witness could have
 * spoken: `findPasses` needs MIN_PASS_M of travel along the geometry, and a
 * segment shorter than that caps every possible span below the threshold. The
 * traversal gate has no such floor (it also accepts a high coverage fraction),
 * so short lines get drawn and can never be witnessed. Calling those phantoms
 * would credit the heading change with removing lines nothing has judged.
 *
 * Past that, no pass means the rider never went that way. With a pass, the
 * question is whether the ride is still drawn: a pass whose fixes mostly
 * landed in a qualifying run somewhere is drawn on the neighbour, and ONE pass
 * drawn nowhere is enough to make the line a real loss, because that is ground
 * the map stops showing.
 */
export function verdictFor(ev: LineEvidence, nextDoorShare = NEXT_DOOR_SHARE): Verdict {
  if (ev.fates.length === 0) {
    return ev.lengthM < MIN_PASS_M ? "no-witness" : "phantom";
  }
  return ev.fates.every((f) => f.share >= nextDoorShare) ? "next-door" : "real-loss";
}

/** The same segment, the other way round. */
export const siblingKey = (key: string): string => {
  const [id, dir] = key.split("|");
  return `${id}|${dir === "forward" ? "backward" : "forward"}`;
};

/**
 * How many lines change verdict as the next-door threshold moves.
 *
 * The share is a judgement call (0.5, one fix in two), and two of the verdicts
 * in this report sit within 10 points of it. A conclusion that flips at 0.4 or
 * 0.6 is a conclusion about the threshold, not about the heading.
 */
export function sensitivity(
  evidence: Map<string, LineEvidence>,
  shares: readonly number[],
): Array<{ share: number } & Record<Verdict, number>> {
  return shares.map((share) => {
    const row = { share, "no-witness": 0, phantom: 0, "next-door": 0, "real-loss": 0 };
    for (const ev of evidence.values()) row[verdictFor(ev, share)]++;
    return row;
  });
}

/** For a `no-witness` line: are the fixes the arm drew here drawn elsewhere? */
export function runFateVerdict(
  ev: LineEvidence,
  nextDoorShare = NEXT_DOOR_SHARE,
): "drawn-elsewhere" | "drawn-nowhere" | "unknown" {
  if (!ev.runFates.length) return "unknown";
  return ev.runFates.every((f) => f.share >= nextDoorShare) ? "drawn-elsewhere" : "drawn-nowhere";
}

/**
 * Where a pass's fixes are drawn under one arm.
 *
 * `drawnFix` holds only QUALIFYING runs, so a fix missing from it is drawn
 * nowhere. `selfKey` is excluded so a line can never be judged as drawn by
 * itself, which would turn every verdict into next-door.
 */
export function fateOf(
  pass: PassRecord,
  fixTimes: ReadonlyArray<{ id: number; atMs: number }>,
  drawnFix: ReadonlyMap<number, string>,
  selfKey: string,
): PassFate {
  const inPass = fixTimes.filter((f) => f.atMs >= pass.startedMs && f.atMs <= pass.endedMs);
  const went = new Map<string, number>();
  let elsewhere = 0;
  for (const f of inPass) {
    const to = drawnFix.get(f.id);
    const label = to == null ? "nothing" : to === selfKey ? "itself" : to;
    if (to != null && to !== selfKey) elsewhere++;
    went.set(label, (went.get(label) ?? 0) + 1);
  }
  return {
    pass,
    fixes: inPass.length,
    share: inPass.length > 0 ? elsewhere / inPass.length : 0,
    top: [...went].sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

/**
 * What one session contributes to the comparison.
 *
 * Buffered rather than classified per ride because a line is only lost if NO
 * session draws it under the other arm, which is not knowable until every ride
 * has been replayed.
 */
export interface SessionBuf {
  sessionId: number;
  fixTimes: Array<{ id: number; atMs: number }>;
  device: ArmBuf;
  derived: ArmBuf;
}

interface ArmBuf {
  drawn: Set<string>;
  runs: DrawnRun[];
  passes: PassRecord[];
  drawnFix: Map<number, string>;
}

type Meta = Pick<Segment, "streetName" | "kind" | "lengthM" | "osmWayId" | "pieceIndex">;

/** Evidence for every line one arm draws and the other does not. */
export function evidenceFor(
  bufs: readonly SessionBuf[],
  from: "device" | "derived",
  lengths: ReadonlyMap<number, number> = new Map(),
): Map<string, LineEvidence> {
  const to = from === "device" ? "derived" : "device";
  const mine = new Set<string>();
  const theirs = new Set<string>();
  for (const b of bufs) {
    for (const k of b[from].drawn) mine.add(k);
    for (const k of b[to].drawn) theirs.add(k);
  }

  const out = new Map<string, LineEvidence>();
  for (const key of [...mine].filter((k) => !theirs.has(k))) {
    const ev: LineEvidence = {
      key,
      sessions: [],
      coveredM: 0,
      lengthM: lengths.get(Number(key.split("|")[0])) ?? 0,
      fates: [],
      runFates: [],
    };
    for (const b of bufs) {
      if (!b[from].drawn.has(key)) continue; // only where this arm actually drew it
      ev.sessions.push(b.sessionId);
      for (const r of b[from].runs) {
        if (`${r.segmentId}|${r.direction}` !== key) continue;
        ev.coveredM += r.coveredM;
        // A run's window, asked the same question as a pass's. `fateOf` takes a
        // PassRecord, so the run is presented as one; it is kept in a separate
        // list so nothing can mistake it for the bearing-free witness.
        ev.runFates.push(
          fateOf(
            { ...r, fixes: 0, startedMs: r.startedMs, endedMs: r.endedMs },
            b.fixTimes,
            b[to].drawnFix,
            key,
          ),
        );
      }
      // Either arm's pass list is the same witness; the union covers the case
      // where only one arm touched the segment and so only one projected it.
      const seen = new Set<string>();
      for (const p of [...b[from].passes, ...b[to].passes]) {
        if (`${p.segmentId}|${p.direction}` !== key) continue;
        const id = `${p.startedMs}|${p.endedMs}`;
        if (seen.has(id)) continue;
        seen.add(id);
        ev.fates.push(fateOf(p, b.fixTimes, b[to].drawnFix, key));
      }
    }
    out.set(key, ev);
  }
  return out;
}

/** The pass list must not depend on the arm, or every verdict is circular. */
export function witnessDisagreements(a: readonly PassRecord[], b: readonly PassRecord[]): {
  checked: number;
  disagreed: number;
} {
  const key = (p: PassRecord) => `${p.segmentId}|${p.direction}|${p.startedMs}|${p.endedMs}`;
  const aSegs = new Set(a.map((p) => p.segmentId));
  const bSegs = new Set(b.map((p) => p.segmentId));
  const shared = new Set([...aSegs].filter((s) => bSegs.has(s)));
  const inShared = (ps: readonly PassRecord[]) =>
    new Set(ps.filter((p) => shared.has(p.segmentId)).map(key));
  const left = inShared(a);
  const right = inShared(b);
  let disagreed = 0;
  for (const k of left) if (!right.has(k)) disagreed++;
  for (const k of right) if (!left.has(k)) disagreed++;
  return { checked: left.size, disagreed };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
const metresOf = (list: readonly LineEvidence[]) => list.reduce((n, e) => n + e.coveredM, 0);

export function byVerdict(evidence: Map<string, LineEvidence>): Map<Verdict, LineEvidence[]> {
  const out = new Map<Verdict, LineEvidence[]>();
  for (const ev of evidence.values()) {
    const v = verdictFor(ev);
    out.set(v, [...(out.get(v) ?? []), ev]);
  }
  return out;
}

function report(
  title: string,
  evidence: Map<string, LineEvidence>,
  meta: Map<number, Meta>,
  order: readonly Verdict[],
  labels: Record<Verdict, string>,
  limit: number,
  /** Lines the OTHER arm draws, so a lost line can say whether the street
   * keeps any paint at all or goes blank. */
  otherArmDraws: ReadonlySet<string> = new Set(),
): void {
  console.log(`\n${title}`);
  const groups = byVerdict(evidence);
  for (const v of order) {
    const list = groups.get(v) ?? [];
    console.log(
      `  ${v.padEnd(10)} ${pad(list.length, 3)} lines  ` +
        `${pad(metresOf(list).toFixed(0), 6)}m   ${labels[v]}`,
    );
  }

  for (const v of order) {
    const list = (groups.get(v) ?? []).slice().sort((a, b) => b.coveredM - a.coveredM);
    if (!list.length) continue;
    console.log(`\n  ${v.toUpperCase()} (${list.length}), widest first:`);
    for (const ev of list.slice(0, limit)) {
      const [idPart, dir] = ev.key.split("|");
      const segmentId = Number(idPart);
      const m = meta.get(segmentId);
      // The weakest pass decides the verdict, so it is the one to print.
      // For a witnessed line the weakest pass is what decides the verdict, so
      // it is the one to print. For a line too short to witness, the run's own
      // window is all there is.
      const pool = ev.fates.length ? ev.fates : v === "no-witness" ? ev.runFates : [];
      const worst = pool.length ? pool.reduce((x, y) => (x.share <= y.share ? x : y)) : null;
      console.log(
        `    #${pad(segmentId, 6)} ${(dir ?? "").padEnd(8)} ` +
          `${(m?.streetName ?? "(unnamed)").padEnd(26)} ${(m?.kind ?? "?").padEnd(8)} ` +
          `len ${pad((m?.lengthM ?? 0).toFixed(0), 4)}m  drew ${pad(ev.coveredM.toFixed(0), 4)}m  ` +
          `s[${ev.sessions.join(",")}]  ` +
          (otherArmDraws.has(siblingKey(ev.key)) ? "street keeps paint " : "STREET GOES BLANK  ") +
          (v === "no-witness"
            ? `${runFateVerdict(ev).padEnd(15)}`
            : `${ev.fates.length} pass`) +
          (worst
            ? `  worst ${pad((100 * worst.share).toFixed(0), 3)}% of ${worst.fixes} fixes elsewhere: ` +
              worst.top.map(([k, n]) => `${n}x ${k}`).join(", ")
            : "  NO PASS WITNESS"),
      );
    }
    if (list.length > limit) console.log(`    ...${list.length - limit} more (--all)`);
  }
}

async function main(): Promise<void> {
  const limit = process.argv.includes("--all") ? 10000 : 25;
  const client = await pool.connect();
  await client.query("set statement_timeout = '15min'");
  const usable = (await loadSessionVerdicts(client)).filter(isUsable);
  console.log(`replaying ${usable.length} sessions under both headings\n`);

  const bufs: SessionBuf[] = [];
  const meta = new Map<number, Meta>();
  let checked = 0;
  let disagreed = 0;
  let done = 0;

  for (const session of usable) {
    const sessionId = session.id;
    const { samples, segments } = await loadRideContext(client, sessionId);
    if (!samples.length) continue;

    const device = traceSession(sessionId, samples, segments, {
      matcher: { headingSource: "device" },
    });
    const derived = traceSession(sessionId, samples, segments, {
      matcher: { headingSource: "derived" },
    });

    const w = witnessDisagreements(device.passes, derived.passes);
    checked += w.checked;
    disagreed += w.disagreed;

    for (const s of segments) {
      const id = s.id;
      const touched = ["forward", "backward"].some(
        (d) => device.drawn.has(`${id}|${d}`) || derived.drawn.has(`${id}|${d}`),
      );
      if (!touched) continue;
      meta.set(id, {
        streetName: s.streetName,
        kind: s.kind,
        lengthM: s.lengthM,
        osmWayId: s.osmWayId,
        pieceIndex: s.pieceIndex,
      });
    }

    bufs.push({
      sessionId,
      fixTimes: (samples as SessionSample[]).map((s) => ({
        id: s.id,
        atMs: Date.parse(s.recordedAt as unknown as string),
      })),
      device: {
        drawn: device.drawn, runs: device.runs, passes: device.passes, drawnFix: device.drawnFix,
      },
      derived: {
        drawn: derived.drawn, runs: derived.runs, passes: derived.passes, drawnFix: derived.drawnFix,
      },
    });

    done++;
    if (done % 10 === 0) console.log(`  ${done}/${usable.length} sessions`);
  }

  const deviceLines = new Set<string>();
  const derivedLines = new Set<string>();
  for (const b of bufs) {
    for (const k of b.device.drawn) deviceLines.add(k);
    for (const k of b.derived.drawn) derivedLines.add(k);
  }
  const lengths = new Map([...meta].map(([id, m]) => [id, m.lengthM]));
  const lost = evidenceFor(bufs, "device", lengths);
  const gained = evidenceFor(bufs, "derived", lengths);

  console.log(`\nCONTROL -- the witness does not depend on the arm`);
  console.log(
    `  ${checked} passes on segments both arms touched, ${disagreed} disagreements` +
      (disagreed === 0 ? "   OK" : "   FAIL: every verdict below is circular"),
  );

  console.log(`\nTHE LEDGER`);
  console.log(`  device draws  ${pad(deviceLines.size, 5)} lines`);
  console.log(`  derived draws ${pad(derivedLines.size, 5)} lines`);
  console.log(
    `  lost          ${pad(lost.size, 5)} lines  ` +
      `${pad(metresOf([...lost.values()]).toFixed(0), 7)}m the device drew`,
  );
  console.log(
    `  gained        ${pad(gained.size, 5)} lines  ` +
      `${pad(metresOf([...gained.values()]).toFixed(0), 7)}m the derived draws`,
  );

  report(
    `THE LINES THE DERIVED HEADING WOULD COST (${lost.size})`,
    lost,
    meta,
    ["real-loss", "next-door", "phantom", "no-witness"],
    {
      "real-loss": "ground drawn nowhere under derived. THE COST.",
      "next-door": "still drawn, on the neighbour. consolidation.",
      phantom: "no pass witness: a direction never ridden. a fix.",
      "no-witness": `shorter than ${MIN_PASS_M}m: unjudgeable. run window only.`,
    },
    limit,
    derivedLines,
  );

  report(
    `THE LINES IT WOULD GAIN (${gained.size})`,
    gained,
    meta,
    ["phantom", "next-door", "real-loss", "no-witness"],
    {
      phantom: "no pass witness: a NEW phantom. a cost, not a gain.",
      "next-door": "the device drew this ground on the neighbour. consolidation.",
      "real-loss": "ground the device drew nowhere. THE GAIN.",
      "no-witness": `shorter than ${MIN_PASS_M}m: unjudgeable. run window only.`,
    },
    limit,
    deviceLines,
  );

  const pick = (m: Map<string, LineEvidence>, v: Verdict) => byVerdict(m).get(v) ?? [];
  const short = (m: Map<string, LineEvidence>, w: "drawn-elsewhere" | "drawn-nowhere") =>
    pick(m, "no-witness").filter((e) => runFateVerdict(e) === w);
  console.log(`\nTHE TRADE, with the phantoms counted separately from the ground`);
  console.table([
    { "": "ground lost", ...tally(pick(lost, "real-loss")) },
    { "": "ground gained", ...tally(pick(gained, "real-loss")) },
    { "": "phantoms removed", ...tally(pick(lost, "phantom")) },
    { "": "phantoms created", ...tally(pick(gained, "phantom")) },
    { "": "consolidated away", ...tally(pick(lost, "next-door")) },
    { "": "consolidated in", ...tally(pick(gained, "next-door")) },
    { "": `under ${MIN_PASS_M}m, lost, drawn elsewhere`, ...tally(short(lost, "drawn-elsewhere")) },
    { "": `under ${MIN_PASS_M}m, lost, drawn nowhere`, ...tally(short(lost, "drawn-nowhere")) },
    { "": `under ${MIN_PASS_M}m, gained`, ...tally(pick(gained, "no-witness")) },
  ]);

  console.log(
    `\nSENSITIVITY -- the lost lines as the next-door share moves. Two verdicts sit within\n` +
      `10 points of the shipped ${NEXT_DOOR_SHARE}, so this says whether the conclusion is about the\n` +
      `heading or about the threshold.`,
  );
  console.table(sensitivity(lost, [0.3, 0.4, NEXT_DOOR_SHARE, 0.6, 0.7]));

  console.log(
    `\nBlind spots. A pass window is a time range, so its fix count includes fixes that were\n` +
      `outside this segment's corridor; the next-door share is computed the same way in\n` +
      `trace-passes, so the two agree, but neither is a per-fix corridor test. A line is\n` +
      `judged over the sessions the arm drew it in, so a line drawn in one ride and missed in\n` +
      `another is judged on the ride where it was drawn. And a segment under ${MIN_PASS_M}m cannot be\n` +
      `witnessed at all: those lines are reported on their run window, which is the matcher's\n` +
      `own opinion of where the rider was, so treat them as unjudged rather than as either\n` +
      `a phantom or a loss.`,
  );

  client.release();
  await pool.end();
}

const tally = (list: readonly LineEvidence[]) => ({
  lines: list.length,
  metres: Number(metresOf(list).toFixed(0)),
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
