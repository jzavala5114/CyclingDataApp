import "dotenv/config";
import { pool } from "../db/pool.js";
import { matchSamplesToSegments, stitchFragmentedRuns } from "../services/segmentMatcher.js";
import { assessRun } from "../services/elevationAggregator.js";
import { rejectElevationSpikes, smoothElevations } from "../services/elevationSmoothing.js";
import { isUsable, loadSessionVerdicts } from "../services/usableSessions.js";
import type { Segment, SessionSample } from "../types/index.js";
// Reaching across into the pipeline is deliberate. This script's whole job is
// to score a pipeline decision against a backend behaviour, so it has to hold
// both; duplicating the frontage rule here to keep the directories tidy would
// mean scoring a copy of the thing instead of the thing.
import { buildLinkPlan, decide, MIN_FRONTAGE } from "../../../osm-pipeline/scripts/lib/linkPlan.mjs";

// What does folding a sidewalk actually do to the map?
//
//   npm run eval:linker            # the shipped threshold
//   npm run eval:linker 0.5,0.6,0.7
//
// `link_canonical.mjs` decides which segments are match candidates. This
// replays the real matcher, gate and stitcher over every usable session with
// the candidate set the database has today, and again with the set the
// frontage rule would produce -- so the question "does folding these paths
// help, and what does it cost" has an answer before anything is written.
//
// Two policies per threshold, because they are not the same change:
//
//   fold   only ever hides more. Whatever is folded today stays folded.
//   both   recomputes every parent from scratch, so a path the old chord rule
//          folded by luck is released again.
//
// Hiding is monotone and can only reduce the number of lines competing for a
// fix. Releasing is the half that can regress a road, and the numbers say so:
// `both` costs Brenner Place #37523 and #8361 their lines. That is why the
// script defaults to fold-only and this eval prints both.
//
// The measure that matters most is the per-line diff at the bottom, not the
// totals. A net bucket count hides a street losing its line to a sidewalk
// gaining one, and this script's subject has destroyed named trails before.
//
// KNOW WHAT THIS CANNOT SEE. It replays the rides in the archive, so a folded
// path that nobody has ridden cannot move a single number here. Of the 745
// folds the frontage rule produces, exactly THREE currently draw a line. The
// other 742 are invisible to this eval and will stay invisible until someone
// rides them. So "0.5, 0.6 and 0.7 give identical results" is a fact about the
// archive as much as about the rule -- the 115 paths separating those
// thresholds have never been ridden. The counts printed below the table say how
// much of the change the replay could actually observe, because a measurement
// that silently covers 0.4% of its subject is worse than no measurement.
//
// READS ONLY. Writes nothing, applies no plan, fetches no terrain.
//
// Local tool, not part of the deployed server. `tsc` emits it into
// dist/scripts/ like the other scripts, but Railway only ships `backend/`, so
// the osm-pipeline import above would not resolve in the container. Nothing
// there loads it -- index.ts does not import it and ES modules resolve per
// module -- so the deploy is unaffected. Run it from a checkout.

const BBOX_PAD_DEG = 0.005;
const DISCONNECT_PENALTY_M = 6; // what the matcher ships with; see session.md
// MIN_FRONTAGE, not a literal. The default arm is described as "the shipped
// threshold" in backend/README.md, and with a hardcoded 0.6 that stops being
// true the moment the constant moves -- which it can, since the suite pins it
// only to a 0.5-to-0.7 range and the fold count swings 809 to 694 across that.
// linkPlan.mjs exists to stop a threshold being chosen by one code path and
// applied by another; this script is a code path.
const THRESHOLDS = (process.argv[2] ?? String(MIN_FRONTAGE)).split(",").map(Number);
const ARMS = ["before", ...THRESHOLDS.flatMap((t) => [`fold>=${t}`, `both>=${t}`])];

// The sessions the published 10.1% impossible-transition baseline was measured
// over. Kept fixed so a number here is comparable with the one in session.md.
const IMPOSSIBLE_SESSIONS = new Set([62, 63, 66, 67, 68, 69, 70, 71, 72]);

interface Totals {
  merged: number;
  discarded: number;
  buckets: number;
  coveredM: number;
  roadM: number;
  trailM: number;
  transitions: number;
  jumps: number;
  drawn: Set<number>;
}
const blank = (): Totals => ({
  merged: 0, discarded: 0, buckets: 0, coveredM: 0, roadM: 0, trailM: 0,
  transitions: 0, jumps: 0, drawn: new Set(),
});

// tmp-impossible.mjs's test, kept identical so the rate is comparable to the
// published baseline: any shared node counts, and piece_index is consulted only
// for two slices of one way.
const connected = (a: Segment, b: Segment) => {
  const nodes = new Set([a.startNodeId, a.endNodeId].map(String));
  if (nodes.has(String(b.startNodeId)) || nodes.has(String(b.endNodeId))) return true;
  if (String(a.osmWayId) === String(b.osmWayId)) return Math.abs(a.pieceIndex - b.pieceIndex) <= 1;
  return false;
};

const client = await pool.connect();
await client.query("set statement_timeout = '10min'");

console.log("measuring frontage for every eligible path...");
const plan = await buildLinkPlan(client, {
  onProgress: (n: number) => {
    if (n % 10000 < 500) console.log(`  ${n} paths`);
  },
});
console.log(`  ${plan.length} eligible paths measured\n`);

const planIds = new Set<number>(plan.map((p) => p.id));
// null means "trust the column as stored".
const hiddenByArm = new Map<string, Set<number> | null>([["before", null]]);
for (const t of THRESHOLDS) {
  const both = new Set<number>();
  const fold = new Set<number>();
  for (const d of decide(plan, t)) {
    if (d.newParent !== null) both.add(d.id);
    if (d.newParent !== null || d.currentParent !== null) fold.add(d.id);
  }
  hiddenByArm.set(`both>=${t}`, both);
  hiddenByArm.set(`fold>=${t}`, fold);
}

const verdicts = await loadSessionVerdicts(client);
const usable = verdicts.filter(isUsable);
console.log(`replaying ${usable.length} usable sessions across ${ARMS.length} candidate sets\n`);

const totals = new Map<string, Totals>(ARMS.map((a) => [a, blank()]));

for (const session of usable) {
  const { rows: samples } = await client.query<SessionSample>(
    `select id, recorded_at as "recordedAt", lat, lon, elevation_m as "elevationM",
            heading_deg as "headingDeg", speed_mps as "speedMps", accuracy_m as "accuracyM"
       from session_samples where session_id = $1 order by recorded_at`,
    [session.id],
  );
  if (!samples.length) continue;

  const lats = samples.map((s) => s.lat);
  const lons = samples.map((s) => s.lon);
  // Every segment in the bbox, canonical or not, plus the column. The arms
  // differ only in which of these they are allowed to see.
  const { rows: all } = await client.query<Segment & { parent: string | null }>(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            piece_index as "pieceIndex", canonical_segment_id as parent,
            bearing_deg as "bearingDeg", length_m as "lengthM",
            st_asgeojson(geom)::json as geom
       from segments
      where geom && st_makeenvelope($1, $2, $3, $4, 4326)`,
    [Math.min(...lons) - BBOX_PAD_DEG, Math.min(...lats) - BBOX_PAD_DEG,
     Math.max(...lons) + BBOX_PAD_DEG, Math.max(...lats) + BBOX_PAD_DEG],
  );

  const { kept } = rejectElevationSpikes(samples);
  const smoothed = smoothElevations(kept);
  const orderById = new Map(smoothed.map((s, i) => [s.id, i]));

  for (const arm of ARMS) {
    const hide = hiddenByArm.get(arm) ?? null;
    const segments = all.filter((s) =>
      hide === null
        ? s.parent === null
        : planIds.has(Number(s.id))
          ? !hide.has(Number(s.id))
          : s.parent === null,
    );
    const byId = new Map(segments.map((s) => [s.id, s]));
    const t = totals.get(arm)!;

    const runs = stitchFragmentedRuns(
      matchSamplesToSegments(smoothed, segments, { disconnectPenaltyM: DISCONNECT_PENALTY_M }),
    );
    const qualified: { segment: Segment; startedMs: number; endedMs: number }[] = [];

    for (const run of runs) {
      const segment = byId.get(run.segmentId);
      if (!segment) continue;
      const first = orderById.get(run.samples[0].id) ?? 0;
      const last = orderById.get(run.samples[run.samples.length - 1].id) ?? 0;
      const a = assessRun(run, segment, {
        before: first > 0 ? smoothed[first - 1] : undefined,
        after: last < smoothed.length - 1 ? smoothed[last + 1] : undefined,
      });
      if (!a.qualified) { t.discarded++; continue; }
      t.merged++;
      t.buckets += a.profile.buckets.length;
      const covered = Math.max(0, a.profile.coveredToM - a.profile.coveredFromM);
      t.coveredM += covered;
      if (segment.kind === "road") t.roadM += covered; else t.trailM += covered;
      t.drawn.add(Number(segment.id));
      qualified.push({
        segment,
        startedMs: Date.parse(run.samples[0].recordedAt as unknown as string),
        endedMs: Date.parse(run.samples[run.samples.length - 1].recordedAt as unknown as string),
      });
    }

    // This membership test is where the text-typed id bit: the Set never
    // matched, `transitions` stayed 0 and the headline printed "n/a". Safe now
    // that loadSessionVerdicts converts the id at the boundary; see
    // SessionVerdict.id.
    if (!IMPOSSIBLE_SESSIONS.has(session.id)) continue;
    qualified.sort((a, b) => a.startedMs - b.startedMs);
    for (let i = 1; i < qualified.length; i++) {
      t.transitions++;
      if (!connected(qualified[i - 1].segment, qualified[i].segment)) t.jumps++;
    }
  }
  process.stdout.write(`\r  replayed session ${session.id}   `);
}
console.log("\n");

console.table(
  ARMS.map((arm) => {
    const t = totals.get(arm)!;
    return {
      arm,
      impossible: t.transitions
        ? `${t.jumps}/${t.transitions} ${((t.jumps / t.transitions) * 100).toFixed(1)}%`
        : "n/a",
      merged: t.merged,
      discard: `${((t.discarded / (t.discarded + t.merged)) * 100).toFixed(1)}%`,
      buckets: t.buckets,
      covered_km: (t.coveredM / 1000).toFixed(2),
      road_km: (t.roadM / 1000).toFixed(2),
      trail_km: (t.trailM / 1000).toFixed(2),
      lines_drawn: t.drawn.size,
    };
  }),
);

// How much of the change could this replay even see? A fold on ground nobody
// has ridden cannot move any number above, and most folds are on such ground.
for (const t of THRESHOLDS) {
  const folds = decide(plan, t).filter((d) => d.change === "fold").map((d) => d.id);
  const { rows: [seen] } = await client.query<{ n: string }>(
    `select count(distinct segment_id)::int as n
       from segment_elevation_buckets where segment_id = any($1)`,
    [folds],
  );
  const n = Number(seen.n);
  console.log(
    `\nCOVERAGE at ${t}: ${folds.length} folds, of which ${n} currently draw a line. ` +
      `The replay is blind to the other ${folds.length - n} ` +
      `(${(((folds.length - n) / folds.length) * 100).toFixed(1)}%), which have never been ridden.`,
  );
}

// The per-line diff. A net count hides a street losing its line to a sidewalk
// gaining one, and that is the failure this whole script exists to catch.
const before = totals.get("before")!.drawn;
for (const arm of ARMS.slice(1)) {
  const after = totals.get(arm)!.drawn;
  const gained = [...after].filter((id) => !before.has(id));
  const lost = [...before].filter((id) => !after.has(id));
  console.log(`\n${arm}: ${gained.length} lines gained, ${lost.length} lost`);
  for (const [label, ids] of [["lost", lost], ["gained", gained]] as const) {
    if (!ids.length) continue;
    const { rows } = await client.query<{
      id: string; street_name: string | null; kind: string; is_sidewalk: boolean; len: string;
    }>(
      `select id, street_name, kind, is_sidewalk, round(length_m::numeric, 0) as len
         from segments where id = any($1) order by length_m desc`,
      [ids],
    );
    console.log(`  ${label}:`);
    for (const r of rows) {
      const warn = label === "lost" && r.kind === "road" ? "   <-- A ROAD LOST ITS LINE" : "";
      console.log(
        `    #${String(r.id).padStart(6)} ${String(r.street_name ?? "(unnamed)").padEnd(26)} ` +
          `${r.kind.padEnd(8)} sw=${String(r.is_sidewalk).padEnd(5)} ${String(r.len).padStart(4)}m${warn}`,
      );
    }
  }
}

client.release();
await pool.end();
