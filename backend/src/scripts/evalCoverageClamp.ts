import "dotenv/config";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { loadSessionVerdicts, isUsable } from "../services/usableSessions.js";
import { rejectElevationSpikes, smoothElevations } from "../services/elevationSmoothing.js";
import {
  matchSamplesToSegments,
  stitchFragmentedRuns,
  buildEndAdjacency,
  type EndNeighbours,
} from "../services/segmentMatcher.js";
import {
  assessRun,
  passageFor,
  clampCoverageToPassage,
  MAX_PASSTHROUGH_GAP_S,
} from "../services/elevationAggregator.js";
import type { Direction, Segment, SessionSample } from "../types/index.js";

// What the coverage clamp would change, before changing it.
//
// Replays every usable ride and records each drawn line's covered extent twice:
// as `bucketizeRun` measures it, and as `clampCoverageToPassage` would widen it.
// Reports the unpainted metres either way, and -- the part that matters -- every
// line whose coverage grows, so an invented stretch of road would be visible
// rather than buried in a total.
//
// Also a control: buckets and drawn lines are compared against the stored model.
// The clamp touches coverage only, so if those move, something in the MATCHER
// changed, and the coverage numbers below would be measuring two things at once.
//
// Read-only. Every query is a select.
//
//   npm run eval:coverage
//   npm run eval:coverage -- --top 40

const BBOX_PAD_DEG = 0.005;
const NO_NEIGHBOURS: EndNeighbours = { start: new Set(), end: new Set() };

interface LineExtent {
  segment: Segment;
  direction: Direction;
  rawFrom: number;
  rawTo: number;
  clampedFrom: number;
  clampedTo: number;
  buckets: Set<number>;
}

const blankM = (l: LineExtent, clamped: boolean) =>
  (clamped ? l.clampedFrom : l.rawFrom) +
  (l.segment.lengthM - (clamped ? l.clampedTo : l.rawTo));

async function main(): Promise<void> {
  const topArg = process.argv.indexOf("--top");
  const top = topArg === -1 ? 20 : Number(process.argv[topArg + 1]);
  if (!(top > 0)) throw new Error("--top needs a positive number");

  const client = await pool.connect();
  await client.query("set statement_timeout = '10min'");

  const usable = (await loadSessionVerdicts(client)).filter(isUsable);
  console.log(`replaying ${usable.length} usable sessions\n`);

  const lines = new Map<string, LineExtent>();
  let done = 0;

  for (const session of usable) {
    const sessionId = Number(session.id);
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

    const { kept } = rejectElevationSpikes(samples);
    const smoothed = smoothElevations(kept);
    const orderById = new Map(smoothed.map((s, i) => [s.id, i]));
    const runs = stitchFragmentedRuns(matchSamplesToSegments(smoothed, segments));
    const byId = new Map(segments.map((s) => [s.id, s]));
    const endAdjacency = buildEndAdjacency(segments);

    const landedOn = new Map<number, number>();
    for (const run of runs) for (const s of run.samples) landedOn.set(s.id, run.segmentId);
    const secondsBetween = (a: SessionSample, b: SessionSample) =>
      Math.abs(Date.parse(b.recordedAt) - Date.parse(a.recordedAt)) / 1000;

    for (const run of runs) {
      const segment = byId.get(run.segmentId);
      if (!segment) continue;
      const firstIndex = orderById.get(run.samples[0]!.id) ?? 0;
      const lastIndex = orderById.get(run.samples[run.samples.length - 1]!.id) ?? 0;
      const before = firstIndex > 0 ? smoothed[firstIndex - 1] : undefined;
      const after = lastIndex < smoothed.length - 1 ? smoothed[lastIndex + 1] : undefined;
      const assessment = assessRun(run, segment, { before, after });
      if (!assessment.qualified) continue;

      const passage = passageFor(
        run.direction,
        endAdjacency.get(segment.id) ?? NO_NEIGHBOURS,
        before ? { segmentId: landedOn.get(before.id) ?? null, gapS: secondsBetween(before, run.samples[0]!) } : null,
        after ? { segmentId: landedOn.get(after.id) ?? null, gapS: secondsBetween(run.samples[run.samples.length - 1]!, after) } : null,
      );
      const extent = clampCoverageToPassage(assessment.profile, segment, passage);

      const key = `${segment.id}|${run.direction}`;
      const line = lines.get(key) ?? {
        segment, direction: run.direction,
        rawFrom: Infinity, rawTo: -Infinity,
        clampedFrom: Infinity, clampedTo: -Infinity,
        buckets: new Set<number>(),
      };
      // Union across runs and rides, exactly as mergeCoverage does.
      line.rawFrom = Math.min(line.rawFrom, assessment.profile.coveredFromM);
      line.rawTo = Math.max(line.rawTo, assessment.profile.coveredToM);
      line.clampedFrom = Math.min(line.clampedFrom, extent.coveredFromM);
      line.clampedTo = Math.max(line.clampedTo, extent.coveredToM);
      for (const b of assessment.profile.buckets) line.buckets.add(b.distanceM);
      lines.set(key, line);
    }

    done++;
    if (done % 10 === 0) console.log(`  ${done}/${usable.length} sessions`);
  }

  const all = [...lines.values()];

  // -- control ----------------------------------------------------------------
  const buckets = all.reduce((n, l) => n + l.buckets.size, 0);
  const drawnSegments = new Set(all.map((l) => Number(l.segment.id))).size;
  const { rows: [stored] } = await client.query<{ buckets: number; segments: number; lines: number }>(
    `select count(*)::int as buckets,
            count(distinct segment_id)::int as segments,
            (select count(*)::int from segment_coverage) as lines
       from segment_elevation_buckets`,
  );
  console.log(`\nCONTROL -- the clamp must not touch the matcher:`);
  console.log(`  replay: ${buckets} buckets, ${drawnSegments} segments, ${all.length} lines`);
  console.log(`  stored: ${stored.buckets} buckets, ${stored.segments} segments, ${stored.lines} lines`);
  const clean =
    buckets === stored.buckets && drawnSegments === stored.segments && all.length === stored.lines;
  console.log(
    clean
      ? "  ^ identical, so every difference below is the clamp and nothing else"
      : "  ^ THESE DIFFER. Something changed which fixes match which segments, so the\n" +
        "    coverage numbers below are measuring two changes at once. Find that first.",
  );

  // -- what the clamp closes --------------------------------------------------
  const rawBlank = all.reduce((n, l) => n + blankM(l, false), 0);
  const clampedBlank = all.reduce((n, l) => n + blankM(l, true), 0);
  console.log(`\nunpainted metres at line ends:`);
  console.log(`  before ${rawBlank.toFixed(0)}m`);
  console.log(`  after  ${clampedBlank.toFixed(0)}m`);
  console.log(
    `  closed ${(rawBlank - clampedBlank).toFixed(0)}m ` +
      `(${((100 * (rawBlank - clampedBlank)) / rawBlank).toFixed(1)}%)`,
  );

  const ends = (clamped: boolean) =>
    all.flatMap((l) => [
      clamped ? l.clampedFrom : l.rawFrom,
      l.segment.lengthM - (clamped ? l.clampedTo : l.rawTo),
    ]);
  const over = (xs: number[], n: number) => xs.filter((v) => v > n).length;
  const b4 = ends(false);
  const af = ends(true);
  console.log(`\nline ends over a given width:   >1m    >3m    >5m   >10m   >20m`);
  console.log(`  before                      ${[1,3,5,10,20].map((n)=>String(over(b4,n)).padStart(5)).join("  ")}`);
  console.log(`  after                       ${[1,3,5,10,20].map((n)=>String(over(af,n)).padStart(5)).join("  ")}`);

  // -- the safety check -------------------------------------------------------
  const grew = all
    .map((l) => ({ l, by: blankM(l, false) - blankM(l, true) }))
    .filter((g) => g.by > 0.5)
    .sort((a, b) => b.by - a.by);
  console.log(`\n${grew.length} lines grow. Biggest first, which is where an invented stretch would show:`);
  for (const { l, by } of grew.slice(0, top)) {
    console.log(
      `  seg ${String(l.segment.id).padStart(6)} ${l.direction.padEnd(8)} ` +
        `${(l.segment.streetName ?? "(unnamed)").padEnd(28)} ${l.segment.kind.padEnd(9)} ` +
        `len ${l.segment.lengthM.toFixed(0).padStart(4)}m  ` +
        `${l.rawFrom.toFixed(1)}-${l.rawTo.toFixed(1)} -> ${l.clampedFrom.toFixed(1)}-${l.clampedTo.toFixed(1)}  ` +
        `+${by.toFixed(1)}m`,
    );
  }
  if (grew.length > top) console.log(`  ... ${grew.length - top} more`);

  const shrank = all.filter((l) => blankM(l, true) > blankM(l, false) + 1e-6);
  console.log(
    shrank.length === 0
      ? "\nNo line loses coverage, which the clamp must never do."
      : `\nWARNING: ${shrank.length} lines LOSE coverage. The clamp is only allowed to widen.`,
  );

  console.log(`\ntime bound ${MAX_PASSTHROUGH_GAP_S}s. Blind spot: this measures the extent only. ` +
    `Whether the\nground inside a widened extent has buckets is a separate question, and it does not.`);

  client.release();
  await pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
