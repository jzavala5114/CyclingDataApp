import "dotenv/config";
import * as turf from "@turf/turf";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { loadSessionVerdicts, isUsable } from "../services/usableSessions.js";
import { rejectElevationSpikes, smoothElevations } from "../services/elevationSmoothing.js";
import {
  matchSamplesToSegments,
  stitchFragmentedRuns,
  MAX_MATCH_DISTANCE_M,
  MAX_ACCURACY_M,
} from "../services/segmentMatcher.js";
import {
  assessRun,
  distanceAlongFor,
  bucketFor,
  BUCKET_SIZE_M,
} from "../services/elevationAggregator.js";
import { interiorHoles, type Hole } from "../services/interiorHoles.js";
import type { Direction, Segment, SessionSample } from "../types/index.js";

// WHY a drawn line has a gap in the middle of it.
//
// `findHoles.ts` counts them from the stored model. This replays every usable
// ride through the real matcher, gate and bucketiser, finds the same holes, and
// then asks what the rider's fixes were doing across each one. The two are
// meant to agree on the count, and the script says so if they do not -- a
// replay that finds different holes is measuring something else.
//
// Four answers are possible, and they need different fixes:
//
//   crossed      One run has two fixes in a row straddling the gap, so the
//                rider demonstrably rode through it and we simply have no
//                reading in between. The slope across it IS measured -- two
//                real heights, a known distance -- so this is drawable without
//                inventing anything.
//   dropped      Fixes exist in the gap and something threw them away: no
//                heading, accuracy past MAX_ACCURACY_M, or an elevation spike.
//   elsewhere    Fixes exist in the gap and the matcher gave them to another
//                segment.
//   between-runs No single run spans it. Two separate passes covered the two
//                ends and nothing covered the middle.
//
// Read-only. Every query is a select.
//
//   npm run diagnose-holes
//   npm run diagnose-holes -- --top 40

const BBOX_PAD_DEG = 0.01;

// Time between the two fixes either side of a gap, as a share of the stitch
// window. A gap crossed inside STITCH_WINDOW_S is one traversal by the same
// test the stitcher already uses; past it, calling it one traversal would be
// asserting something the rest of the code declines to assert.
const GAP_BANDS_S = [5, 15, 45, 120];

type Cause = "crossed" | "dropped" | "elsewhere" | "between-runs";

interface HoleDiagnosis {
  segmentId: number;
  streetName: string | null;
  kind: string;
  direction: Direction;
  segmentLengthM: number;
  hole: Hole;
  cause: Cause;
  /** Seconds between the two fixes straddling the gap, for `crossed`. */
  straddleGapS: number | null;
  /** Ground metres between those two fixes. */
  straddleGroundM: number | null;
  /** Raw fixes inside the gap, and why each is not in the model. */
  rawInGap: number;
  droppedNoHeading: number;
  droppedAccuracy: number;
  droppedSpike: number;
  matchedElsewhere: number;
  sessionId: number;
}

/** One fix as the replay sees it, with where it falls along the segment. */
interface Placed {
  id: number;
  atMs: number;
  distanceM: number;
  lat: number;
  lon: number;
}

/**
 * Does one run have two consecutive fixes that straddle this gap?
 *
 * Consecutive in TIME, not in distance: a rider who doubles back produces
 * fixes whose distances are not monotonic, and the pair that matters is the
 * one the rider actually travelled between. Returns the tightest such pair,
 * because a gap crossed once quickly and once slowly is explained by the quick
 * crossing.
 *
 * **Compared in bucket space, and that is the whole correctness of it.** A
 * hole's `fromM` and `toM` are grid positions, while a fix sits wherever it
 * sits: a fix at 50m is the bucket at 45m, and one at 100m is the bucket at
 * 105m. Testing the raw distances against the grid positions asks `50 <= 45`,
 * which is false, so the pair that produced both edges of the gap does not
 * recognise its own gap. Rounding both sides first asks `45 <= 45`, which is
 * the question. The first version of this reported 152 of 173 holes as spanned
 * by no run, and it was reporting a unit mismatch.
 */
export function straddlingPair(
  placed: readonly Placed[],
  hole: Hole,
): { gapS: number; groundM: number } | null {
  let best: { gapS: number; groundM: number } | null = null;
  for (let i = 1; i < placed.length; i++) {
    const a = placed[i - 1]!;
    const b = placed[i]!;
    const ba = bucketFor(a.distanceM);
    const bb = bucketFor(b.distanceM);
    const lo = Math.min(ba, bb);
    const hi = Math.max(ba, bb);
    // The step has to reach the buckets on both sides of the gap. Reaching only
    // one of them crossed part of the gap, which is a different claim and is
    // not what "crossed" means here.
    if (!(lo <= hole.fromM && hi >= hole.toM)) continue;
    const gapS = (b.atMs - a.atMs) / 1000;
    const groundM = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (!best || gapS < best.gapS) best = { gapS, groundM };
  }
  return best;
}

const EARTH_R_M = 6_371_008.8;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Which band a gap's duration falls in, as a label. */
export function band(gapS: number): string {
  for (const edge of GAP_BANDS_S) if (gapS <= edge) return `<=${edge}s`;
  return `>${GAP_BANDS_S[GAP_BANDS_S.length - 1]}s`;
}

async function main(): Promise<void> {
  const topArg = process.argv.indexOf("--top");
  const top = topArg === -1 ? 25 : Number(process.argv[topArg + 1]);
  if (!(top > 0)) throw new Error(`--top needs a positive number`);

  const client = await pool.connect();
  await client.query("set statement_timeout = '10min'");

  const verdicts = await loadSessionVerdicts(client);
  const usable = verdicts.filter(isUsable);
  console.log(`replaying ${usable.length} usable sessions of ${verdicts.length}\n`);

  // Per (segment, direction): every bucket any qualifying run produced, and
  // every run's placed fixes, so a hole can be interrogated afterwards.
  interface Line {
    segment: Segment;
    direction: Direction;
    buckets: Set<number>;
    runs: Array<{ sessionId: number; placed: Placed[] }>;
    // Raw fixes near this segment that never reached a qualifying run, with the
    // reason. Keyed by bucket so a hole can look up its own stretch.
    dropped: Map<number, { noHeading: number; accuracy: number; spike: number }>;
    elsewhere: Map<number, number>;
  }
  const lines = new Map<string, Line>();
  const keyFor = (id: number, d: Direction) => `${id}|${d}`;

  let done = 0;
  for (const session of usable) {
    const sessionId = session.id;
    const { rows: samples } = await client.query<SessionSample>(
      `select id, recorded_at as "recordedAt", lat, lon, elevation_m as "elevationM",
              heading_deg as "headingDeg", speed_mps as "speedMps", accuracy_m as "accuracyM"
         from session_samples where session_id = $1 order by recorded_at`,
      [sessionId],
    );
    if (!samples.length) continue;

    const lats = samples.map((s) => s.lat);
    const lons = samples.map((s) => s.lon);
    const { rows: segments } = await client.query<Segment>(
      `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
              start_node_id as "startNodeId", end_node_id as "endNodeId",
              piece_index as "pieceIndex", bearing_deg as "bearingDeg",
              length_m as "lengthM", st_asgeojson(geom)::json as geom
         from segments
        where geom && st_makeenvelope($1, $2, $3, $4, 4326)
          and canonical_segment_id is null`,
      [Math.min(...lons) - BBOX_PAD_DEG, Math.min(...lats) - BBOX_PAD_DEG,
       Math.max(...lons) + BBOX_PAD_DEG, Math.max(...lats) + BBOX_PAD_DEG],
    );

    const { kept, rejected } = rejectElevationSpikes(samples);
    const smoothed = smoothElevations(kept);
    const orderById = new Map(smoothed.map((s, i) => [s.id, i]));
    const spikeIds = new Set(rejected.map((s) => s.id));
    const keptIds = new Set(kept.map((s) => s.id));

    const runs = stitchFragmentedRuns(matchSamplesToSegments(smoothed, segments));
    const byId = new Map(segments.map((s) => [s.id, s]));

    // Which segment each fix ended up on, so "matched elsewhere" is answerable.
    const landedOn = new Map<number, number>();
    for (const run of runs) for (const s of run.samples) landedOn.set(s.id, run.segmentId);

    const qualifiedKeys = new Set<string>();
    for (const run of runs) {
      const segment = byId.get(run.segmentId);
      if (!segment) continue;
      const first = orderById.get(run.samples[0]!.id) ?? 0;
      const last = orderById.get(run.samples[run.samples.length - 1]!.id) ?? 0;
      const a = assessRun(run, segment, {
        before: first > 0 ? smoothed[first - 1] : undefined,
        after: last < smoothed.length - 1 ? smoothed[last + 1] : undefined,
      });
      if (!a.qualified) continue;

      const key = keyFor(segment.id, run.direction);
      qualifiedKeys.add(key);
      const distanceAlong = distanceAlongFor(segment, run.direction);
      const fresh: Line = {
        segment,
        direction: run.direction,
        buckets: new Set(),
        runs: [],
        dropped: new Map(),
        elsewhere: new Map(),
      };
      const line = lines.get(key) ?? fresh;
      for (const b of a.profile.buckets) line.buckets.add(b.distanceM);
      line.runs.push({
        sessionId,
        placed: run.samples.map((s) => ({
          id: s.id,
          atMs: Date.parse(s.recordedAt as unknown as string),
          distanceM: distanceAlong(s),
          lat: s.lat,
          lon: s.lon,
        })),
      });
      lines.set(key, line);
    }

    // Now the fixes that did NOT make it, attributed to the lines they were
    // near. Only for segments this ride actually drew something on, because a
    // segment with no line has no hole.
    for (const key of qualifiedKeys) {
      const line = lines.get(key)!;
      const distanceAlong = distanceAlongFor(line.segment, line.direction);
      for (const sample of samples) {
        if (keptIds.has(sample.id) && landedOn.get(sample.id) === line.segment.id) continue;
        const d = distanceAlong(sample);
        // Inside the segment and close enough that the matcher would have
        // considered it. Without the corridor test every fix of the whole ride
        // would be attributed to every line.
        if (d < 0 || d > line.segment.lengthM) continue;
        const bucket = bucketFor(d);
        const near = nearSegment(sample, line.segment);
        if (!near) continue;

        if (spikeIds.has(sample.id)) {
          bump(line.dropped, bucket, "spike");
        } else if (sample.headingDeg == null || sample.headingDeg < 0) {
          bump(line.dropped, bucket, "noHeading");
        } else if (sample.accuracyM != null && sample.accuracyM > MAX_ACCURACY_M) {
          bump(line.dropped, bucket, "accuracy");
        } else if (landedOn.has(sample.id)) {
          line.elsewhere.set(bucket, (line.elsewhere.get(bucket) ?? 0) + 1);
        }
      }
    }

    done++;
    if (done % 10 === 0) console.log(`  ${done}/${usable.length} sessions`);
  }

  // -- diagnose ---------------------------------------------------------------

  const diagnoses: HoleDiagnosis[] = [];
  for (const line of lines.values()) {
    const holes = interiorHoles([...line.buckets]);
    for (const hole of holes) {
      let straddle: { gapS: number; groundM: number } | null = null;
      let sessionId = 0;
      for (const run of line.runs) {
        const found = straddlingPair(run.placed, hole);
        if (found && (!straddle || found.gapS < straddle.gapS)) {
          straddle = found;
          sessionId = run.sessionId;
        }
      }

      let rawInGap = 0;
      let noHeading = 0;
      let accuracy = 0;
      let spike = 0;
      let elsewhere = 0;
      for (let b = hole.fromM + BUCKET_SIZE_M; b < hole.toM; b += BUCKET_SIZE_M) {
        const d = line.dropped.get(b);
        if (d) {
          noHeading += d.noHeading;
          accuracy += d.accuracy;
          spike += d.spike;
        }
        elsewhere += line.elsewhere.get(b) ?? 0;
      }
      rawInGap = noHeading + accuracy + spike + elsewhere;

      const cause: Cause = straddle
        ? "crossed"
        : noHeading + accuracy + spike > 0
          ? "dropped"
          : elsewhere > 0
            ? "elsewhere"
            : "between-runs";

      diagnoses.push({
        segmentId: line.segment.id,
        streetName: line.segment.streetName,
        kind: line.segment.kind,
        direction: line.direction,
        segmentLengthM: line.segment.lengthM,
        hole,
        cause,
        straddleGapS: straddle?.gapS ?? null,
        straddleGroundM: straddle?.groundM ?? null,
        rawInGap,
        droppedNoHeading: noHeading,
        droppedAccuracy: accuracy,
        droppedSpike: spike,
        matchedElsewhere: elsewhere,
        sessionId,
      });
    }
  }

  const holeLines = new Set(diagnoses.map((d) => `${d.segmentId}|${d.direction}`));
  console.log(`\nreplay found ${diagnoses.length} holes across ${holeLines.size} lines`);
  const { rows: [stored] } = await client.query<{ holes: number; lines: number }>(
    `with ordered as (
       select segment_id, direction, distance_m,
              lead(distance_m) over (partition by segment_id, direction order by distance_m) as next_m
         from segment_elevation_buckets)
     select count(*) filter (where next_m - distance_m > $1)::int as holes,
            count(distinct (segment_id, direction)) filter (where next_m - distance_m > $1)::int as lines
       from ordered where next_m is not null`,
    [BUCKET_SIZE_M],
  );
  console.log(`stored model has  ${stored.holes} holes across ${stored.lines} lines`);
  if (stored.holes !== diagnoses.length || stored.lines !== holeLines.size) {
    console.log(
      "  ^ THESE DISAGREE. The replay is not reproducing the stored model, so the\n" +
        "    causes below describe a different set of holes. Likely reasons: the\n" +
        "    model was built before a matcher change, or a ride has been added since\n" +
        "    the last rebuild. Run `npm run rebuild-model` and compare again before\n" +
        "    trusting the split.",
    );
  } else {
    console.log("  ^ they agree, so the causes below describe the holes on the map");
  }

  const byCause = new Map<Cause, HoleDiagnosis[]>();
  for (const d of diagnoses) byCause.set(d.cause, [...(byCause.get(d.cause) ?? []), d]);
  console.log("\nby cause:");
  for (const cause of ["crossed", "dropped", "elsewhere", "between-runs"] as Cause[]) {
    const list = byCause.get(cause) ?? [];
    const metres = list.reduce((n, d) => n + d.hole.gapM, 0);
    console.log(
      `  ${cause.padEnd(13)} ${String(list.length).padStart(4)} holes  ${String(metres).padStart(5)}m`,
    );
  }

  const crossed = byCause.get("crossed") ?? [];
  if (crossed.length > 0) {
    const bands = new Map<string, number>();
    for (const d of crossed) {
      const b = band(d.straddleGapS!);
      bands.set(b, (bands.get(b) ?? 0) + 1);
    }
    console.log("\ntime between the two fixes either side of a crossed gap:");
    for (const edge of [...GAP_BANDS_S.map((e) => `<=${e}s`), `>${GAP_BANDS_S.at(-1)}s`]) {
      if (bands.has(edge)) console.log(`  ${edge.padEnd(8)} ${bands.get(edge)}`);
    }
    const gaps = crossed.map((d) => d.straddleGapS!).sort((a, b) => a - b);
    const ground = crossed.map((d) => d.straddleGroundM!).sort((a, b) => a - b);
    const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
    console.log(
      `  seconds  median ${q(gaps, 0.5).toFixed(1)}  p90 ${q(gaps, 0.9).toFixed(1)}  max ${gaps.at(-1)!.toFixed(1)}`,
    );
    console.log(
      `  ground   median ${q(ground, 0.5).toFixed(1)}m  p90 ${q(ground, 0.9).toFixed(1)}m  max ${ground.at(-1)!.toFixed(1)}m`,
    );
  }

  console.log(`\nwidest holes, with the cause (top ${top}):`);
  for (const d of [...diagnoses].sort((a, b) => b.hole.gapM - a.hole.gapM).slice(0, top)) {
    const why =
      d.cause === "crossed"
        ? `crossed in ${d.straddleGapS!.toFixed(0)}s over ${d.straddleGroundM!.toFixed(0)}m ground (session ${d.sessionId})`
        : d.cause === "dropped"
          ? `${d.rawInGap} fixes dropped: ${d.droppedNoHeading} no heading, ${d.droppedAccuracy} accuracy, ${d.droppedSpike} spike`
          : d.cause === "elsewhere"
            ? `${d.matchedElsewhere} fixes matched to another segment`
            : "no run spans it";
    console.log(
      `  seg ${String(d.segmentId).padStart(6)} ${d.direction.padEnd(8)} ` +
        `${(d.streetName ?? "(unnamed)").padEnd(28)} ${d.kind.padEnd(9)} ` +
        `len ${d.segmentLengthM.toFixed(0).padStart(4)}m  ` +
        `hole ${String(d.hole.gapM).padStart(3)}m at ${d.hole.fromM}->${d.hole.toM}m  ${why}`,
    );
  }

  console.log(
    `\nBlind spots: a hole is only visible where a bucket exists either side, so ` +
      `ground missing from both\nends of a line is not counted here. And ` +
      `"between-runs" holes have no straddling pair by definition,\nso nothing ` +
      `here says whether the rider rode that ground on some other pass.`,
  );

  client.release();
  await pool.end();
}

function bump(
  map: Map<number, { noHeading: number; accuracy: number; spike: number }>,
  bucket: number,
  which: "noHeading" | "accuracy" | "spike",
): void {
  const entry = map.get(bucket) ?? { noHeading: 0, accuracy: 0, spike: 0 };
  entry[which] += 1;
  map.set(bucket, entry);
}

/**
 * Is this fix inside the corridor the matcher would have considered?
 *
 * Perpendicular distance to the centreline, by turf rather than by hand: the
 * matcher's own `pointToEdgeM` is private and works on a precomputed edge list,
 * and reproducing it here would be a third copy of the same arithmetic. The
 * two agree to well under a metre at this latitude, which is far inside a 25m
 * corridor.
 */
function nearSegment(sample: { lat: number; lon: number }, segment: Segment): boolean {
  const offsetM = turf.pointToLineDistance(
    turf.point([sample.lon, sample.lat]),
    turf.lineString(segment.geom.coordinates),
    { units: "meters" },
  );
  return offsetM <= MAX_MATCH_DISTANCE_M;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
