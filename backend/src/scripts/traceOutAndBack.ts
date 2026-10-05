import "dotenv/config";
import * as turf from "@turf/turf";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { loadSessionVerdicts, isUsable } from "../services/usableSessions.js";
import { rejectElevationSpikes, smoothElevations } from "../services/elevationSmoothing.js";
import {
  matchSamplesToSegments,
  stitchFragmentedRuns,
  MAX_ACCURACY_M,
  type MatchOptions,
} from "../services/segmentMatcher.js";
import { assessRun } from "../services/elevationAggregator.js";
import { findPasses, CORRIDOR_M, type ProjectedFix, type Pass } from "../services/segmentPasses.js";
import type { Direction, Segment, SessionSample } from "../types/index.js";

// Why does riding a segment both ways draw only one direction?
//
// `findPasses` decides what the rider did, from the projected fixes and the
// clock alone -- no headings, no candidates, no gate. The replay then says what
// the matcher did with the same fixes. Every pass the rider made that the
// matcher did not produce a qualifying run for is a loss, and each loss gets a
// cause:
//
//   no-run       The matcher never started a run on this segment+direction
//                during the pass. The fixes went somewhere else, or nowhere.
//   gate         A run existed and the traversal gate rejected it.
//   wrong-dir    A run existed over this ground in the OTHER direction, so the
//                bearing test read the pass backwards.
//   dropped      The pass's fixes were filtered out before matching: no
//                heading, accuracy past MAX_ACCURACY_M, or an elevation spike.
//
// Only segments where the rider made passes BOTH ways are reported by default,
// because a one-way pass that draws one direction is correct and there are
// hundreds of them.
//
// Read-only. Every query is a select.
//
//   npm run trace-passes
//   npm run trace-passes -- --all      # every lost pass, not only out-and-backs
//   npm run trace-passes -- --top 40

const BBOX_PAD_DEG = 0.005;

export type Cause = "next-door" | "no-run" | "gate" | "wrong-dir" | "dropped";

/**
 * What is known about one lost pass before a cause is chosen.
 *
 * Every cause is a claim about where the pass's fixes went, so the evidence is
 * gathered first and `classifyLoss` only orders the claims. Pulled out of the
 * replay loop so the ORDER is testable without driving the whole matcher
 * through contrived geometry -- the defect this fixed was an ordering bug, and
 * ordering was the one thing nothing could reach.
 */
export interface LossEvidence {
  /** Runs on this segment, this direction, overlapping the pass. */
  right: readonly { qualified: boolean; spanM: number; coverage: number }[];
  /** Runs on this segment, the OTHER direction, overlapping the pass. */
  opposite: readonly { qualified: boolean; direction: Direction }[];
  /** Fixes recorded during the pass, raw -- including ones never offered to the matcher. */
  fixesInPass: number;
  /** ...of which the matcher never saw: spike, no heading, or accuracy past MAX_ACCURACY_M. */
  fixesUnavailable: number;
  /**
   * ...of which landed in a drawn run on a DIFFERENT segment.
   *
   * The same segment in the other direction is excluded by the caller: those
   * fixes are `wrong-dir`'s evidence, and counting them here would make every
   * wrong-dir case read as next-door.
   */
  fixesDrawnElsewhere: number;
  /** ...of which landed in the (rejected) run on this segment and direction. */
  fixesInRunHere: number;
  /**
   * ...of `fixesDrawnElsewhere`, how many landed on another piece of THIS OSM
   * way. A neighbour inside the corridor is detector generosity; the next piece
   * of the same street is the map painting the wrong stretch of it.
   */
  fixesOnSameWay: number;
  /** Top destinations, pre-formatted, for the detail string. */
  destinations: string;
  noHeading: number;
  looseAccuracy: number;
  spikes: number;
}

/**
 * Why one pass the rider made is not drawn.
 *
 * **The order is the whole content of this function**, and it used to be
 * wrong. `gate` was tried first and fired on the mere EXISTENCE of a run on
 * this segment and direction, so one stray fix forming a 1-fix run beat the
 * share test below it, and a pass whose fixes were all drawn on the segment
 * next door was filed as a traversal-gate rejection.
 *
 * Measured over the 42 usable rides on 2026-10-04, that mislabelled **9 of 12
 * `gate` losses, 605m of the 784m the ledger called a gate defect** -- which
 * was the evidence behind a standing proposal to lower the gate. The note under
 * "The 36 lines, enumerated" predicted it ("`on_touching > 0` is a one-fix
 * threshold ... a share threshold matching NEXT_DOOR_SHARE would be consistent
 * with the project"); this is that fix.
 *
 * Claims are tried strongest first, where strongest means "makes the most
 * specific statement that the evidence can refute".
 */
export function classifyLoss(e: LossEvidence): { cause: Cause; detail: string; sameWay: boolean } {
  const share = e.fixesInPass > 0 ? e.fixesDrawnElsewhere / e.fixesInPass : 0;
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  // A SHARE, not `> 0`, and the reason is the defect this function was just
  // fixed for. The first version of this flag used `fixesOnSameWay > 0` and
  // fired on 202 passes / 11.6km -- which is not a positional-error class, it is
  // a long trail cut into pieces where a rider always leaves a fix or two on the
  // piece next door at the boundary. One fix is not evidence of anything, which
  // is the entire lesson of the `gate` ordering bug above, reintroduced one
  // function later by the person who fixed it.
  const sameWayShare = e.fixesInPass > 0 ? e.fixesOnSameWay / e.fixesInPass : 0;
  const sameWay = sameWayShare >= NEXT_DOOR_SHARE;
  // Said on every verdict that reports a destination, because `next-door`
  // otherwise reads as "fine, drawn on the neighbour" for a case that is the
  // map painting a different stretch of the street the rider was actually on.
  const wayNote = sameWay
    ? ` [${e.fixesOnSameWay}/${e.fixesInPass} on ANOTHER PIECE OF THE SAME WAY, not a neighbour]`
    : "";

  // A QUALIFYING run over the same ground at the same time, pointing the other
  // way. The rider sees a line; it is the wrong one. Nothing else explains that
  // better, so this is tried before any share.
  const backwards = e.opposite.find((r) => r.qualified);
  if (backwards) {
    return {
      cause: "wrong-dir",
      detail: `the matcher drew ${backwards.direction} over the same ground and time`,
      sameWay,
    };
  }

  // The ride IS drawn, on another segment. Checked before `gate` because a run
  // existing here says nothing when most of the pass went elsewhere.
  if (share >= NEXT_DOOR_SHARE) {
    return {
      cause: "next-door",
      detail:
        `${pct(share)} of ${e.fixesInPass} fixes drawn on another segment: ${e.destinations}` +
        wayNote,
      sameWay,
    };
  }

  // If most of the pass never reached the matcher, no downstream stage can be
  // blamed for what it did with what it never got.
  if (e.fixesUnavailable > e.fixesInPass / 2) {
    return {
      cause: "dropped",
      detail:
        `${e.fixesUnavailable}/${e.fixesInPass} fixes filtered out: ${e.noHeading} no heading, ` +
        `${e.looseAccuracy} accuracy, ${e.spikes} spike`,
      sameWay,
    };
  }

  // Only now is the gate the explanation: a run over this ground, in this
  // direction, that the gate rejected, with nothing better to blame. The fix
  // share is in the detail because a `gate` verdict on a run holding 2 of 29
  // fixes is not a gate problem and the number gets quoted as one.
  if (e.right.length > 0) {
    const widest = e.right.reduce((a, b) => (a.spanM > b.spanM ? a : b));
    return {
      cause: "gate",
      detail:
        `run existed, span ${widest.spanM.toFixed(0)}m / ${pct(widest.coverage)} of segment, ` +
        `holding ${e.fixesInRunHere}/${e.fixesInPass} of the pass's fixes; ` +
        `${pct(share)} drawn elsewhere: ${e.destinations}` + wayNote,
      sameWay,
    };
  }

  return {
    cause: "no-run",
    detail:
      `${pct(share)} of ${e.fixesInPass} fixes drawn on another segment: ${e.destinations}` +
      wayNote,
    sameWay,
  };
}

// How much of a pass's fixes must land in a qualifying run elsewhere before the
// ride counts as drawn on a neighbour rather than lost.
//
// This distinction is the whole point of the report. `findPasses` deliberately
// uses no bearings, so on a braided trail -- several mapped lines inside one
// 25m corridor with different tangents -- it reports a pass on every line whose
// projection sweeps, and most of those the rider never rode. A pass whose fixes
// all ended up drawn on the line next door is the detector being generous, not
// the map being wrong. A pass whose fixes are drawn nowhere is the defect.
export const NEXT_DOOR_SHARE = 0.5;

export interface Loss {
  sessionId: number;
  segment: Segment;
  pass: Pass;
  cause: Cause;
  detail: string;
  /**
   * The pass was drawn on another PIECE OF THE SAME OSM WAY, not a neighbour.
   *
   * `next-door` means "the detector was generous, the map is fine": the rider
   * was really on the parallel line inside the corridor. That reading does not
   * survive when the ground is drawn on the adjacent piece of the same street.
   * East Fountain Boulevard `#30947` -> `#30948` is the case: the rider swept
   * 31m of a 38m piece and the map paints the piece after it. That is a ~38m
   * positional error, and without this flag it is invisible inside a bucket of
   * 363 entries that is excluded from the defect total.
   */
  sameWay: boolean;
}

/** One qualifying run: a line the map draws, and what it contributed. */
export interface DrawnRun {
  sessionId: number;
  segmentId: number;
  direction: Direction;
  spanM: number;
  coverage: number;
  buckets: number;
  coveredM: number;
  startedMs: number;
  endedMs: number;
}

/** One pass `findPasses` saw. Bearing-free, so identical under every arm. */
export interface PassRecord {
  sessionId: number;
  segmentId: number;
  direction: Direction;
  spanM: number;
  fixes: number;
  startedMs: number;
  endedMs: number;
}

/** What one ride looks like under one matcher setting. */
export interface SessionTrace {
  losses: Loss[];
  /** Segments this ride passed over in both directions. */
  bothWays: number;
  /** ...of which the map draws both. */
  bothWaysDrawn: number;
  onePassSegments: number;
  merged: number;
  discarded: number;
  buckets: number;
  coveredM: number;
  /** `segmentId|direction` for every qualifying run, so arms can be compared. */
  drawn: Set<string>;
  /** The same runs as `drawn`, with their contribution, for naming a difference. */
  runs: DrawnRun[];
  /**
   * Every pass on every segment the matcher touched, in BOTH directions,
   * regardless of `keepOneWay`. A line one arm draws and another does not is
   * only judgeable against a witness that does not depend on the arm, and this
   * is it: `findPasses` reads projection and the clock, never a heading.
   */
  passes: PassRecord[];
  /**
   * Fix id -> the `segmentId|direction` of the QUALIFYING run holding it.
   * A fix missing from here is drawn nowhere under this arm.
   */
  drawnFix: Map<number, string>;
}

/** Where every fix of a session falls on one segment. */
function projectAll(samples: readonly SessionSample[], segment: Segment): ProjectedFix[] {
  const line = turf.lineString(segment.geom.coordinates);
  return samples.map((s) => {
    const point = turf.point([s.lon, s.lat]);
    const snapped = turf.nearestPointOnLine(line, point, { units: "meters" });
    return {
      atMs: Date.parse(s.recordedAt as unknown as string),
      distanceM: snapped.properties.location ?? 0,
      offsetM: snapped.properties.dist ?? Infinity,
    };
  });
}

/** Do two intervals overlap at all? */
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 <= b1 && b0 <= a1;

/** The segments a replay needs, for the box around one ride. */
export async function loadRideContext(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  sessionId: number,
): Promise<{ samples: SessionSample[]; segments: Segment[] }> {
  const { rows: samples } = (await client.query(
    `select id, recorded_at as "recordedAt", lat, lon, elevation_m as "elevationM",
            heading_deg as "headingDeg", speed_mps as "speedMps", accuracy_m as "accuracyM"
       from session_samples where session_id = $1 order by recorded_at`,
    [sessionId],
  )) as { rows: SessionSample[] };
  if (!samples.length) return { samples: [], segments: [] };

  const lats = samples.map((s) => s.lat);
  const lons = samples.map((s) => s.lon);
  const { rows: segments } = (await client.query(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            piece_index as "pieceIndex", bearing_deg as "bearingDeg",
            length_m as "lengthM", st_asgeojson(geom)::json as geom
       from segments
      where geom && st_makeenvelope($1, $2, $3, $4, 4326)
        and canonical_segment_id is null`,
    [Math.min(...lons) - BBOX_PAD_DEG, Math.min(...lats) - BBOX_PAD_DEG,
     Math.max(...lons) + BBOX_PAD_DEG, Math.max(...lats) + BBOX_PAD_DEG],
  )) as { rows: Segment[] };
  return { samples, segments };
}

/**
 * One ride, replayed and attributed.
 *
 * Exported so a sweep over a matcher setting runs through exactly this, rather
 * than through a second copy of the classification that could disagree with it.
 * `matcher` is forwarded straight to `matchSamplesToSegments`.
 */
export function traceSession(
  sessionId: number,
  samples: readonly SessionSample[],
  segments: Segment[],
  {
    keepOneWay = false,
    matcher,
  }: { keepOneWay?: boolean; matcher?: MatchOptions } = {},
): SessionTrace {
  const losses: Loss[] = [];
  let bothWays = 0;
  let bothWaysDrawn = 0;
  let onePassSegments = 0;
  let merged = 0;
  let discarded = 0;
  let buckets = 0;
  let coveredM = 0;
  const drawn = new Set<string>();
  const runRecords: DrawnRun[] = [];
  const passRecords: PassRecord[] = [];
  const drawnFix = new Map<number, string>();
  const all = keepOneWay;

  {
    const { kept, rejected } = rejectElevationSpikes(samples as SessionSample[]);
    const smoothed = smoothElevations(kept);
    const orderById = new Map(smoothed.map((s, i) => [s.id, i]));
    const spikeIds = new Set(rejected.map((s) => s.id));
    const runs = stitchFragmentedRuns(matchSamplesToSegments(smoothed, segments, matcher));
    const byId = new Map(segments.map((s) => [s.id, s]));

    // Every run on this ride, qualified or not, with its extent in time.
    interface RunRecord {
      segmentId: number;
      direction: Direction;
      startedMs: number;
      endedMs: number;
      qualified: boolean;
      spanM: number;
      coverage: number;
    }
    // Which segment and direction each fix ended up on, so a lost pass can say
    // where its fixes went instead of only that they did not stay.
    const landedOn = new Map<number, number>();
    const landedDirection = new Map<number, Direction>();
    for (const run of runs) {
      for (const s of run.samples) {
        landedOn.set(s.id, run.segmentId);
        landedDirection.set(s.id, run.direction);
      }
    }

    const records: RunRecord[] = [];
    for (const run of runs) {
      const segment = byId.get(run.segmentId);
      if (!segment) continue;
      const first = orderById.get(run.samples[0]!.id) ?? 0;
      const last = orderById.get(run.samples[run.samples.length - 1]!.id) ?? 0;
      const a = assessRun(run, segment, {
        before: first > 0 ? smoothed[first - 1] : undefined,
        after: last < smoothed.length - 1 ? smoothed[last + 1] : undefined,
      });
      records.push({
        segmentId: run.segmentId,
        direction: run.direction,
        startedMs: Date.parse(run.samples[0]!.recordedAt as unknown as string),
        endedMs: Date.parse(run.samples[run.samples.length - 1]!.recordedAt as unknown as string),
        qualified: a.qualified,
        spanM: a.spanM,
        coverage: a.coverageFraction,
      });
      // The same health counters evalLinkerFold reports, so a sweep can see a
      // direction fix paid for with lost coverage.
      if (a.qualified) {
        merged++;
        buckets += a.profile.buckets.length;
        const runCoveredM = Math.max(0, a.profile.coveredToM - a.profile.coveredFromM);
        coveredM += runCoveredM;
        const key = `${run.segmentId}|${run.direction}`;
        drawn.add(key);
        runRecords.push({
          sessionId,
          segmentId: run.segmentId,
          direction: run.direction,
          spanM: a.spanM,
          coverage: a.coverageFraction,
          buckets: a.profile.buckets.length,
          coveredM: runCoveredM,
          startedMs: Date.parse(run.samples[0]!.recordedAt as unknown as string),
          endedMs: Date.parse(run.samples[run.samples.length - 1]!.recordedAt as unknown as string),
        });
        for (const s of run.samples) drawnFix.set(s.id, key);
      } else {
        discarded++;
      }
    }

    // Only segments this ride came near are worth projecting against: the bbox
    // holds thousands and projecting every fix onto every one of them is the
    // whole cost of this script.
    const touched = new Set(runs.map((r) => r.segmentId));
    for (const segmentId of touched) {
      const segment = byId.get(segmentId);
      if (!segment) continue;
      const passes = findPasses(projectAll(samples, segment));
      // Recorded before the one-way and empty cases return, so the witness is
      // the same list whatever this run of the trace was asked to report.
      for (const p of passes) {
        passRecords.push({
          sessionId,
          segmentId,
          direction: p.direction,
          spanM: p.spanM,
          fixes: p.fixes,
          startedMs: p.startedMs,
          endedMs: p.endedMs,
        });
      }
      const dirs = new Set(passes.map((p) => p.direction));
      if (passes.length === 0) continue;
      if (dirs.size < 2) {
        onePassSegments++;
        if (!all) continue;
      } else {
        bothWays++;
        const drawn = new Set(
          records.filter((r) => r.segmentId === segmentId && r.qualified).map((r) => r.direction),
        );
        if (drawn.size === 2) bothWaysDrawn++;
      }

      for (const pass of passes) {
        const mine = records.filter(
          (r) =>
            r.segmentId === segmentId &&
            overlaps(pass.startedMs, pass.endedMs, r.startedMs, r.endedMs),
        );
        const right = mine.filter((r) => r.direction === pass.direction);
        if (right.some((r) => r.qualified)) continue; // the matcher got it

        const opposite = mine.filter((r) => r.direction !== pass.direction);

        // THE EVIDENCE. Gathered here, ordered in `classifyLoss`.
        const inPass = samples.filter((s) => {
          const t = Date.parse(s.recordedAt as unknown as string);
          return t >= pass.startedMs && t <= pass.endedMs;
        });
        const unavailable = inPass.filter(
          (s) =>
            spikeIds.has(s.id) ||
            s.headingDeg == null ||
            s.headingDeg < 0 ||
            (s.accuracyM != null && s.accuracyM > MAX_ACCURACY_M),
        );
        // Drawn on ANOTHER segment. The same segment in the other direction is
        // `wrong-dir`'s territory and is excluded here deliberately: counting
        // it would make every wrong-dir case read as next-door, since those
        // fixes are by definition drawn on this segment backwards.
        const drawnElsewhere = inPass.filter((s) => {
          const to = landedOn.get(s.id);
          if (to == null || to === segmentId) return false;
          const dir = landedDirection.get(s.id);
          return records.some((r) => r.segmentId === to && r.direction === dir && r.qualified);
        }).length;
        // How much of the pass the run here actually claimed.
        const inRunHere = inPass.filter(
          (s) => landedOn.get(s.id) === segmentId && landedDirection.get(s.id) === pass.direction,
        ).length;

        // Where the fixes went, for the detail strings. "nothing" is a
        // destination too: matched nowhere is a different defect from matched
        // next door.
        const went = new Map<string, number>();
        for (const s of inPass) {
          const to = landedOn.get(s.id);
          const key =
            to == null
              ? "nothing"
              : `#${to} ${byId.get(to)?.streetName ?? "(unnamed)"} ${landedDirection.get(s.id)}`;
          went.set(key, (went.get(key) ?? 0) + 1);
        }
        const destinations =
          [...went]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, n]) => `${n}x ${k}`)
            .join(", ") + (went.size > 3 ? `, +${went.size - 3} more` : "");

        // Of the fixes drawn elsewhere, the ones on another piece of THIS way.
        // Same test as `drawnElsewhere`, narrowed by `osmWayId`.
        const onSameWay = inPass.filter((s) => {
          const to = landedOn.get(s.id);
          if (to == null || to === segmentId) return false;
          if (byId.get(to)?.osmWayId !== segment.osmWayId) return false;
          const dir = landedDirection.get(s.id);
          return records.some((r) => r.segmentId === to && r.direction === dir && r.qualified);
        }).length;

        const { cause, detail, sameWay } = classifyLoss({
          right,
          opposite,
          fixesInPass: inPass.length,
          fixesUnavailable: unavailable.length,
          fixesDrawnElsewhere: drawnElsewhere,
          fixesInRunHere: inRunHere,
          fixesOnSameWay: onSameWay,
          destinations,
          noHeading: inPass.filter((s) => s.headingDeg == null || s.headingDeg < 0).length,
          looseAccuracy: inPass.filter((s) => (s.accuracyM ?? 0) > MAX_ACCURACY_M).length,
          spikes: inPass.filter((s) => spikeIds.has(s.id)).length,
        });
        losses.push({ sessionId, segment, pass, cause, detail, sameWay });
      }
    }
  }

  return {
    losses, bothWays, bothWaysDrawn, onePassSegments, merged, discarded, buckets, coveredM,
    drawn, runs: runRecords, passes: passRecords, drawnFix,
  };
}

async function main(): Promise<void> {
  const keepOneWay = process.argv.includes("--all");
  const topArg = process.argv.indexOf("--top");
  const top = topArg === -1 ? 25 : Number(process.argv[topArg + 1]);
  if (!(top > 0)) throw new Error("--top needs a positive number");

  const client = await pool.connect();
  await client.query("set statement_timeout = '15min'");
  const usable = (await loadSessionVerdicts(client)).filter(isUsable);
  console.log(`tracing ${usable.length} usable sessions\n`);

  const losses: Loss[] = [];
  let bothWays = 0;
  let bothWaysDrawn = 0;
  let onePassSegments = 0;
  let done = 0;

  for (const session of usable) {
    const sessionId = session.id;
    const { samples, segments } = await loadRideContext(client, sessionId);
    if (!samples.length) continue;
    const t = traceSession(sessionId, samples, segments, { keepOneWay });
    losses.push(...t.losses);
    bothWays += t.bothWays;
    bothWaysDrawn += t.bothWaysDrawn;
    onePassSegments += t.onePassSegments;

    done++;
    if (done % 10 === 0) console.log(`  ${done}/${usable.length} sessions`);
  }

  console.log(`\nsegments ridden BOTH ways in one session: ${bothWays}`);
  console.log(`  of those, both directions drawn: ${bothWaysDrawn} (${((100 * bothWaysDrawn) / Math.max(1, bothWays)).toFixed(0)}%)`);
  console.log(`  one-way-only segments seen (not reported unless --all): ${onePassSegments}`);

  console.log(`\n${losses.length} passes the rider made that the map does not draw, by cause:`);
  const byCause = new Map<Cause, Loss[]>();
  for (const l of losses) byCause.set(l.cause, [...(byCause.get(l.cause) ?? []), l]);
  for (const cause of ["next-door", "no-run", "gate", "wrong-dir", "dropped"] as Cause[]) {
    const list = byCause.get(cause) ?? [];
    const metres = list.reduce((n, l) => n + l.pass.spanM, 0);
    console.log(`  ${cause.padEnd(10)} ${String(list.length).padStart(4)}  ${metres.toFixed(0).padStart(6)}m`);
  }

  // `next-door` is excluded from the defect total on the grounds that the ride
  // IS drawn, just on the parallel line the detector was generous about. That
  // reading fails when the neighbour is the next piece of the same street, so
  // the exception is counted here rather than left inside the bucket.
  const sameWay = losses.filter((l) => l.cause === "next-door" && l.sameWay);
  if (sameWay.length > 0) {
    console.log(
      `\n${sameWay.length} of those next-door passes (${sameWay.reduce((n, l) => n + l.pass.spanM, 0).toFixed(0)}m) ` +
        `are drawn MOSTLY on another piece of the SAME OSM WAY.\n` +
        `  Worth separating because "drawn on the neighbour, the map is fine" is the reason ` +
        `next-door is\n  excluded from the defect total, and that reading is weaker here: the ` +
        `rider rode one stretch of\n  a street and the paint is on a different stretch of the ` +
        `same street. NOT asserted to be a\n  defect -- on a long way cut into pieces the ` +
        `boundary is approximate by construction, and\n  whether these are mispainted or just ` +
        `shifted by a few metres is not measured here.\n` +
        `  Observed but NOT explained: almost every street here is a mountain switchback trail\n` +
        `  (Sinuosa, Culebras, Ladders, Ridgeway, Ridge, Red Rover, Palmer Point, Ute Valley),\n` +
        `  where sibling pieces of one way can run parallel inside the ${CORRIDOR_M}m corridor and ` +
        `so\n  fool a bearing-free detector the same way two parallel streets do. Two guesses at ` +
        `the\n  mechanism were made on 2026-10-04 and both were wrong. It needs its own measurement.`,
    );
    for (const l of [...sameWay].sort((a, b) => b.pass.spanM - a.pass.spanM)) {
      console.log(
        `  s${String(l.sessionId).padStart(2)} seg ${String(l.segment.id).padStart(6)} ` +
          `${l.pass.direction.padEnd(8)} ${(l.segment.streetName ?? "(unnamed)").padEnd(26)} ` +
          `way ${l.segment.osmWayId}  len ${l.segment.lengthM.toFixed(0)}m  pass ${l.pass.spanM.toFixed(0)}m`,
      );
    }
  }

  // The two causes that are defects rather than detector generosity. A
  // next-door pass is drawn, just on the neighbour; these are not drawn at all.
  const real = losses.filter((l) => l.cause === "wrong-dir" || l.cause === "gate");
  console.log(
    `\nTHE DEFECTS: ${real.length} passes, ${real.reduce((n, l) => n + l.pass.spanM, 0).toFixed(0)}m, ` +
      `not drawn anywhere. Widest first:`,
  );
  for (const l of [...real].sort((a, b) => b.pass.spanM - a.pass.spanM).slice(0, top)) {
    console.log(
      `  s${String(l.sessionId).padStart(2)} seg ${String(l.segment.id).padStart(6)} ` +
        `${l.pass.direction.padEnd(8)} ${(l.segment.streetName ?? "(unnamed)").padEnd(26)} ` +
        `${l.segment.kind.padEnd(8)} len ${l.segment.lengthM.toFixed(0).padStart(4)}m  ` +
        `pass ${l.pass.spanM.toFixed(0).padStart(4)}m  ${l.cause.toUpperCase()}: ${l.detail}`,
    );
  }

  console.log(`\nall lost passes, widest first (top ${top}):`);
  for (const l of [...losses].sort((a, b) => b.pass.spanM - a.pass.spanM).slice(0, top)) {
    console.log(
      `  s${String(l.sessionId).padStart(2)} seg ${String(l.segment.id).padStart(6)} ` +
        `${l.pass.direction.padEnd(8)} ${(l.segment.streetName ?? "(unnamed)").padEnd(26)} ` +
        `${l.segment.kind.padEnd(8)} len ${l.segment.lengthM.toFixed(0).padStart(4)}m  ` +
        `pass ${l.pass.spanM.toFixed(0).padStart(4)}m (${l.pass.fixes} fixes)  ` +
        `${l.cause.toUpperCase()}: ${l.detail}`,
    );
  }

  console.log(
    `\nCorridor ${CORRIDOR_M}m, the matcher's own. Blind spots: a pass is only seen on a ` +
      `segment\nthe matcher already touched at least once, so a segment it missed entirely is ` +
      `invisible here;\nand a rider who really did ride only one way is correctly not counted, ` +
      `which is most of the 532.`,
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
