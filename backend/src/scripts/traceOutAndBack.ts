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

type Cause = "next-door" | "no-run" | "gate" | "wrong-dir" | "dropped";

// How much of a pass's fixes must land in a qualifying run elsewhere before the
// ride counts as drawn on a neighbour rather than lost.
//
// This distinction is the whole point of the report. `findPasses` deliberately
// uses no bearings, so on a braided trail -- several mapped lines inside one
// 25m corridor with different tangents -- it reports a pass on every line whose
// projection sweeps, and most of those the rider never rode. A pass whose fixes
// all ended up drawn on the line next door is the detector being generous, not
// the map being wrong. A pass whose fixes are drawn nowhere is the defect.
const NEXT_DOOR_SHARE = 0.5;

export interface Loss {
  sessionId: number;
  segment: Segment;
  pass: Pass;
  cause: Cause;
  detail: string;
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
        coveredM += Math.max(0, a.profile.coveredToM - a.profile.coveredFromM);
        drawn.add(`${run.segmentId}|${run.direction}`);
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

        let cause: Cause;
        let detail: string;
        const opposite = mine.filter((r) => r.direction !== pass.direction);
        if (right.length > 0) {
          const worst = right.reduce((a, b) => (a.spanM > b.spanM ? a : b));
          cause = "gate";
          detail = `run existed, span ${worst.spanM.toFixed(0)}m / ${(worst.coverage * 100).toFixed(0)}% of segment`;
        } else if (opposite.some((r) => r.qualified)) {
          cause = "wrong-dir";
          detail = `the matcher drew ${opposite[0]!.direction} over the same ground and time`;
        } else {
          // Were the fixes even available to match?
          const inPass = samples.filter((s) => {
            const t = Date.parse(s.recordedAt as unknown as string);
            return t >= pass.startedMs && t <= pass.endedMs;
          });
          const lost = inPass.filter(
            (s) =>
              spikeIds.has(s.id) ||
              s.headingDeg == null ||
              s.headingDeg < 0 ||
              (s.accuracyM != null && s.accuracyM > MAX_ACCURACY_M),
          );
          if (lost.length > inPass.length / 2) {
            const noHeading = inPass.filter((s) => s.headingDeg == null || s.headingDeg < 0).length;
            const loose = inPass.filter((s) => (s.accuracyM ?? 0) > MAX_ACCURACY_M).length;
            cause = "dropped";
            detail = `${lost.length}/${inPass.length} fixes filtered out: ${noHeading} no heading, ${loose} accuracy, ${inPass.filter((s) => spikeIds.has(s.id)).length} spike`;
          } else {
            // Where DID they go? "No run here" with the fixes all on one
            // neighbour is a different problem from "no run here" with the
            // fixes matching nothing at all, and the fixes are the only way to
            // tell. Reported as the top destinations by share.
            const went = new Map<string, number>();
            for (const s of inPass) {
              const to = landedOn.get(s.id);
              const key = to == null
                ? "nothing"
                : (() => {
                    const seg = byId.get(to);
                    const dir = landedDirection.get(s.id);
                    return `#${to} ${seg?.streetName ?? "(unnamed)"} ${dir}`;
                  })();
              went.set(key, (went.get(key) ?? 0) + 1);
            }
            const top3 = [...went].sort((a, b) => b[1] - a[1]).slice(0, 3);
            const drawnElsewhere = inPass.filter((s) => {
              const to = landedOn.get(s.id);
              if (to == null) return false;
              const dir = landedDirection.get(s.id);
              return records.some((r) => r.segmentId === to && r.direction === dir && r.qualified);
            }).length;
            const share = inPass.length > 0 ? drawnElsewhere / inPass.length : 0;
            cause = share >= NEXT_DOOR_SHARE ? "next-door" : "no-run";
            detail =
              `${(share * 100).toFixed(0)}% of ${inPass.length} fixes drawn elsewhere: ` +
              top3.map(([k, n]) => `${n}x ${k}`).join(", ") +
              (went.size > 3 ? `, +${went.size - 3} more` : "");
          }
        }
        losses.push({ sessionId, segment, pass, cause, detail });
      }
    }
  }

  return { losses, bothWays, bothWaysDrawn, onePassSegments, merged, discarded, buckets, coveredM, drawn };
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
    const sessionId = Number(session.id);
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
