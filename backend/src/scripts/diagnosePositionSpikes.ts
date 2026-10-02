import "dotenv/config";
import * as turf from "@turf/turf";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { loadSessionVerdicts, isUsable } from "../services/usableSessions.js";
import { loadRideContext } from "./traceOutAndBack.js";
import { measurePositionSpikes, isSpike, quantiles } from "../services/positionSpikes.js";
import { MAX_ACCURACY_M, MAX_MATCH_DISTANCE_M } from "../services/segmentMatcher.js";
import type { Segment, SessionSample } from "../types/index.js";

// Does a sideways GPS spike actually cost anything?
//
// The note this answers says: "No position smoothing. A lateral multipath spike
// downtown (seen clearly on South Weber) passes straight through if it is inside
// the 30m accuracy filter. A jump filter rejecting physically impossible
// sideways movement would clip these cheaply." Written as an observation, never
// measured. Three other hypotheses in that same file were measured this week
// and two of them were wrong, so this one gets measured before anything is
// built.
//
// Existing is not the same as mattering. A fix 12m off its chord on a 40m-wide
// road corridor still matches the same street, and clipping it would buy
// nothing. So the headline number here is not how many spikes there are, it is
// HOW MANY MOVE THE MATCH: the nearest centreline at the fix's reported
// position differs from the nearest centreline at the position the chord
// between its neighbours implies. That is the only way a spike can change what
// the map draws.
//
// Read-only. Every query is a select.
//
//   npm run diagnose-spikes
//   npm run diagnose-spikes -- --top 40

/** Plausible ceiling for a bicycle on these rides, in m/s. ~58 km/h. */
const BIKE_CEILING_MPS = 16;

/** The grid of rules to count, so a threshold is read off the archive. */
const CROSS_M = [5, 8, 10, 12, 15, 20];
const RATIOS = [0.3, 0.5, 0.8];

/** The rule the report leads with, and the one the detail list uses. */
const HEADLINE = { minCrossM: 10, crossToChord: 0.5 };

interface Moved {
  sessionId: number;
  sampleId: number;
  crossTrackM: number;
  chordM: number;
  impliedMps: number;
  accuracyM: number | null;
  reportedMps: number | null;
  /** Nearest segment at the reported position, and at the implied one. */
  atReported: Near;
  atImplied: Near;
  /** Both centrelines belong to the same OSM way, so the move is a shuffle
   * between two pieces of one street rather than a jump to a different one. */
  sameWay: boolean;
  /** The fix also claims a speed no bicycle reaches. */
  impossibleSpeed: boolean;
}

type Near = { id: number; name: string; distanceM: number; wayId: string | null } | null;

/** Nearest centreline to a point, within the matcher's own corridor. */
function nearest(
  lon: number,
  lat: number,
  lines: Array<{ segment: Segment; line: ReturnType<typeof turf.lineString> }>,
): Near {
  let best: Near = null;
  const point = turf.point([lon, lat]);
  for (const { segment, line } of lines) {
    const d = turf.pointToLineDistance(point, line, { units: "meters" });
    if (d > MAX_MATCH_DISTANCE_M) continue;
    if (!best || d < best.distanceM) {
      best = {
        id: Number(segment.id),
        name: segment.streetName ?? "(unnamed)",
        distanceM: d,
        wayId: segment.osmWayId == null ? null : String(segment.osmWayId),
      };
    }
  }
  return best;
}

async function main(): Promise<void> {
  const topArg = process.argv.indexOf("--top");
  const top = topArg === -1 ? 25 : Number(process.argv[topArg + 1]);
  if (!(top > 0)) throw new Error("--top needs a positive number");

  const client = await pool.connect();
  await client.query("set statement_timeout = '15min'");
  const usable = (await loadSessionVerdicts(client)).filter(isUsable);
  console.log(`measuring ${usable.length} usable sessions\n`);

  const crossAll: number[] = [];
  const impliedAll: number[] = [];
  let fixes = 0;
  let measured = 0;
  let overCeiling = 0;
  let overCeilingInsideFilter = 0;
  // rule key -> [count, inside the accuracy filter]
  const grid = new Map<string, [number, number]>();
  const movers: Moved[] = [];
  let headlineSpikes = 0;
  let headlineInsideFilter = 0;
  let headlineChecked = 0;
  let done = 0;

  for (const session of usable) {
    const sessionId = Number(session.id);
    const { samples, segments } = await loadRideContext(client, sessionId);
    if (samples.length < 3) continue;
    fixes += samples.length;

    const lines: Array<{ segment: Segment; line: ReturnType<typeof turf.lineString> }> = segments.map((segment) => ({
      segment,
      line: turf.lineString(segment.geom.coordinates),
    }));

    const measures = measurePositionSpikes(samples as SessionSample[]);
    measured += measures.length;

    for (const m of measures) {
      crossAll.push(m.crossTrackM);
      impliedAll.push(m.impliedMps);
      const insideFilter = m.accuracyM == null || m.accuracyM <= MAX_ACCURACY_M;
      if (Number.isFinite(m.impliedMps) && m.impliedMps > BIKE_CEILING_MPS) {
        overCeiling++;
        if (insideFilter) overCeilingInsideFilter++;
      }

      for (const minCrossM of CROSS_M) {
        for (const crossToChord of RATIOS) {
          if (!isSpike(m, { minCrossM, crossToChord })) continue;
          const key = `${minCrossM}|${crossToChord}`;
          const cell = grid.get(key) ?? [0, 0];
          cell[0]++;
          if (insideFilter) cell[1]++;
          grid.set(key, cell);
        }
      }

      if (!isSpike(m, HEADLINE)) continue;
      headlineSpikes++;
      if (insideFilter) headlineInsideFilter++;

      // Where would the fix be if the rider had gone straight between its
      // neighbours? Compared at the same fraction of the chord the fix itself
      // sits at, so a fix genuinely early or late along the block is not moved
      // forwards or backwards as a side effect of straightening it.
      const before = samples[m.index - 1]!;
      const after = samples[m.index + 1]!;
      const t = m.chordM > 0 ? Math.min(1, Math.max(0, m.alongTrackM / m.chordM)) : 0.5;
      const impliedLon = before.lon + (after.lon - before.lon) * t;
      const impliedLat = before.lat + (after.lat - before.lat) * t;

      const atReported = nearest(samples[m.index]!.lon, samples[m.index]!.lat, lines);
      const atImplied = nearest(impliedLon, impliedLat, lines);
      headlineChecked++;
      if (atReported?.id !== atImplied?.id) {
        movers.push({
          sessionId,
          sampleId: m.sampleId,
          crossTrackM: m.crossTrackM,
          chordM: m.chordM,
          impliedMps: m.impliedMps,
          accuracyM: m.accuracyM,
          reportedMps: m.reportedMps,
          atReported,
          atImplied,
          sameWay:
            atReported?.wayId != null &&
            atImplied?.wayId != null &&
            atReported.wayId === atImplied.wayId,
          impossibleSpeed: Number.isFinite(m.impliedMps) && m.impliedMps > BIKE_CEILING_MPS,
        });
      }
    }

    done++;
    if (done % 10 === 0) console.log(`  ${done}/${usable.length} sessions`);
  }

  const fmt = (q: Array<{ p: number; value: number }>) =>
    q.map(({ p, value }) => `p${(p * 100).toFixed(0)} ${value.toFixed(1)}`).join("  ");

  console.log(`\nPART 1 -- what the archive looks like. ${fixes} fixes, ${measured} measurable.`);
  console.log(`  cross track from the chord (m): ${fmt(quantiles(crossAll, [0.5, 0.9, 0.99, 0.999, 1]))}`);
  console.log(`  implied ground speed (m/s):    ${fmt(quantiles(impliedAll, [0.5, 0.9, 0.99, 0.999, 1]))}`);
  console.log(
    `  over ${BIKE_CEILING_MPS} m/s (~${(BIKE_CEILING_MPS * 3.6).toFixed(0)} km/h): ${overCeiling} ` +
      `(${((100 * overCeiling) / Math.max(1, measured)).toFixed(2)}%), of which ` +
      `${overCeilingInsideFilter} pass the ${MAX_ACCURACY_M}m accuracy filter today`,
  );

  console.log(`\nPART 2 -- how many fixes each rule would call a spike.`);
  console.log(`  (second number: how many of those the ${MAX_ACCURACY_M}m accuracy filter admits today)`);
  console.table(
    CROSS_M.map((minCrossM) => {
      const row: Record<string, string> = { "cross >=": `${minCrossM}m` };
      for (const ratio of RATIOS) {
        const [n, inside] = grid.get(`${minCrossM}|${ratio}`) ?? [0, 0];
        row[`ratio ${ratio}`] = `${n} (${inside})`;
      }
      return row;
    }),
  );

  console.log(
    `\nPART 3 -- DOES IT MATTER? Of ${headlineSpikes} spikes at cross >= ${HEADLINE.minCrossM}m and ` +
      `ratio ${HEADLINE.crossToChord}\n(${headlineInsideFilter} of them invisible to the accuracy ` +
      `filter), how many sit nearer a DIFFERENT\ncentreline than the straight line between their ` +
      `neighbours implies?`,
  );
  console.log(
    `\n  ${movers.length} of ${headlineChecked} move the match ` +
      `(${((100 * movers.length) / Math.max(1, headlineChecked)).toFixed(1)}%)`,
  );
  // A move between two slices of one OSM way is not the ride jumping streets.
  // `split_ways.mjs` cuts a long run into 150m pieces, so two adjacent slices
  // of South Wahsatch are the same road and a fix crossing between them costs
  // a bucket on each side, not a wrong street. Counting those as the cost would
  // overstate it by the share below.
  const sameWay = movers.filter((v) => v.sameWay);
  const crossWay = movers.filter((v) => !v.sameWay);
  const pct = (n: number, d: number) => ((100 * n) / Math.max(1, d)).toFixed(3);
  console.log(
    `    ${sameWay.length} land on another PIECE OF THE SAME WAY -- a boundary shuffle between\n` +
      `      two slices of one street, costing a bucket or two and no drawn line`,
  );
  console.log(`    ${crossWay.length} land on a DIFFERENT WAY -- attributed to another street entirely`);
  console.log(
    `\n  THE COST, as a share of every measurable fix: ${pct(crossWay.length, measured)}% ` +
      `(${crossWay.length} of ${measured})`,
  );
  console.log(
    `  of those ${crossWay.length}, ${crossWay.filter((v) => v.impossibleSpeed).length} also claim a speed ` +
      `over ${BIKE_CEILING_MPS} m/s, so an implied-speed rule\n  alone would catch that many without any ` +
      `cross-track geometry`,
  );

  if (movers.length) {
    console.log(`\n  widest first (top ${top}):`);
    for (const v of movers.sort((a, b) => b.crossTrackM - a.crossTrackM).slice(0, top)) {
      const show = (x: Near) =>
        x ? `#${x.id} ${x.name} @${x.distanceM.toFixed(0)}m` : "nothing in range";
      console.log(
        `    ${v.sameWay ? "same-way " : "CROSS-WAY"} s${String(v.sessionId).padStart(2)} fix ${String(v.sampleId).padStart(7)}  ` +
          `cross ${v.crossTrackM.toFixed(0).padStart(3)}m  chord ${v.chordM.toFixed(0).padStart(3)}m  ` +
          `${v.impliedMps.toFixed(0).padStart(3)} m/s  acc ${(v.accuracyM ?? 0).toFixed(0).padStart(3)}m  ` +
          `reported ${show(v.atReported)}  ->  straightened ${show(v.atImplied)}`,
      );
    }
  }

  console.log(
    `\nBlind spots. Each fix is measured against its RAW neighbours, so two adjacent spikes\n` +
      `partly hide each other and this is an under-count. "Moves the match" uses nearest\n` +
      `centreline only -- no bearing test, no connectivity, no hysteresis -- so it is what the\n` +
      `spike does to the geometry, not a prediction of what the real matcher would do with it.\n` +
      `And a fix can move the match without changing the drawn map, if the run it belongs to\n` +
      `survives on the right segment anyway.`,
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
