import "dotenv/config";
import { pool } from "../db/pool.js";
import { processSession, type DiscardedRun } from "../services/sessionProcessor.js";

// Rebuilds segment_elevation_buckets from scratch out of the raw samples.
//
// session_samples is the only durable record of a ride; the model is a pure
// function of it, so any change to matching, bucketing or the traversal gate
// needs a rebuild before the map reflects it. Averages are running means, and
// a single run's contribution cannot be subtracted back out of one, so there
// is no way to revise the model in place -- it has to be recomputed whole.
//
// Runs the same processSession() the live /sessions/:id/end route uses.
//
//   npx tsx src/scripts/rebuildModel.ts [--dry-run]
//
// Sessions recorded before the barometer/GPS anchoring fix hold elevations on
// a ride-relative scale (-12m..+2m) rather than absolute metres. Averaging
// those into absolute readings produced buckets around 900m and slopes of
// -6000%, and their raw samples cannot be converted after the fact. Rather
// than keep a list of bad session ids in someone's head, the scale itself is
// the test: anything below this is not an altitude above sea level.
const MIN_PLAUSIBLE_ELEVATION_M = 1000;

// The barometer stops delivering when the screen locks -- expo-sensors has no
// background counterpart to expo-location's task -- and the phone falls back to
// GPS altitude, which is ~100x worse vertically. Rides recorded before
// session_samples.elevation_source existed carry no record of which they used,
// so as with the scale test above, the data itself is the test.
//
// Barometer and GPS-altitude stretches have different noise signatures. The
// median absolute *second* difference of a session's elevation series isolates
// that: it cancels the genuine slope and leaves only the roughness. Measured
// across the archive:
//
//   0.35 - 0.49 m   barometer throughout   (sessions 5, 6, 11-15, 29, 42, 48, 52)
//   0.69 - 0.89 m   mixed                  (sessions 43, 47, 49, 51, 53, 54)
//   1.48 - 6.39 m   GPS altitude           (sessions 45, 46, 50)
//
// Session 45 swings 1989.92 -> 1992.60 -> 1983.71 on fixes ~8m apart. A 9m drop
// and recovery over 8m of ground is not terrain. Its *horizontal* accuracy read
// 4-19m throughout, which is why this went unnoticed: horizontal accuracy says
// nothing about vertical.
//
// Set in the empty band between 0.89 and 1.48 rather than below the middle
// group, and that choice is load-bearing. Cutting at 0.6 to catch the mixed
// rides as well drops 9 sessions and half the archive, and takes 97 segments
// down to no coverage at all -- every mountain trail recorded so far, including
// all of Chamberlain, Ridge Trail, The Chutes, Ladders and the BeaUTEiful Loop.
// Cutting here drops 3 sessions and 244 samples and loses no segment entirely.
// The mixed rides are partly real barometer data and are the only trail data
// there is; going forward elevation_source labels them per sample, which is
// what actually fixes them.
//
// Rides carrying elevation_source are exempt -- once a ride says what it used,
// guessing from noise is strictly worse.
const MAX_PLAUSIBLE_ROUGHNESS_M = 1.2;

const dryRun = process.argv.includes("--dry-run");

const { rows: sessions } = await pool.query<{
  id: number;
  samples: number;
  min_elev: number | null;
  roughness_m: number | null;
  labelled: number;
  scale_ok: boolean;
  roughness_ok: boolean;
}>(
  `with curvature as (
     select session_id,
            abs(elevation_m
                - 2 * lag(elevation_m, 1) over w
                + lag(elevation_m, 2) over w) as curv
       from session_samples
     window w as (partition by session_id order by recorded_at)
   ),
   roughness as (
     select session_id,
            percentile_cont(0.5) within group (order by curv) as median_curv
       from curvature where curv is not null group by session_id
   )
   select s.id,
          count(ss.id)::int as samples,
          min(ss.elevation_m) as min_elev,
          max(r.median_curv) as roughness_m,
          count(ss.elevation_source)::int as labelled,
          coalesce(min(ss.elevation_m) >= $1, false) as scale_ok,
          -- A labelled ride is trusted on its own account; an unlabelled one
          -- has to pass the noise test. A ride too short to have a second
          -- difference has no roughness and is let through on the scale test.
          (count(ss.elevation_source) > 0
             or coalesce(max(r.median_curv) <= $2, true)) as roughness_ok
     from sessions s
     left join session_samples ss on ss.session_id = s.id
     left join roughness r on r.session_id = s.id
    group by s.id
    having count(ss.id) > 0
    order by s.id`,
  [MIN_PLAUSIBLE_ELEVATION_M, MAX_PLAUSIBLE_ROUGHNESS_M],
);

const usable = sessions.filter((s) => s.scale_ok && s.roughness_ok);
const skipped = sessions.filter((s) => !(s.scale_ok && s.roughness_ok));

console.log(`sessions with samples: ${sessions.length}`);
for (const s of skipped) {
  const why = !s.scale_ok
    ? `min elevation ${s.min_elev?.toFixed(1)}m is not absolute`
    : `elevation roughness ${s.roughness_m?.toFixed(2)}m exceeds ${MAX_PLAUSIBLE_ROUGHNESS_M}m — recorded on GPS altitude, not the barometer`;
  console.log(`  skipping session ${s.id} (${s.samples} samples): ${why}`);
}
console.log(`rebuilding from ${usable.length} sessions: ${usable.map((s) => s.id).join(", ")}`);

if (dryRun) {
  console.log("\n--dry-run, nothing written");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let totalMatched = 0;
let totalDiscarded = 0;
const allDiscards: Array<DiscardedRun & { sessionId: number }> = [];
try {
  await client.query("begin");
  // One transaction, so a failure part way through leaves the existing model
  // untouched rather than a half-rebuilt one.
  await client.query("delete from session_segment_matches");
  await client.query("delete from segment_coverage");
  await client.query("delete from segment_elevation_buckets");

  for (const session of usable) {
    const { matchedRuns, discardedRuns, demOffsetM, demPoints, discards } = await processSession(
      client,
      session.id,
    );
    totalMatched += matchedRuns;
    totalDiscarded += discardedRuns;
    for (const discard of discards) allDiscards.push({ ...discard, sessionId: session.id });
    // demOffsetM is (ours - DEM); the correction applied is its negation.
    const anchor =
      demOffsetM == null
        ? "unanchored"
        : `shifted ${(-demOffsetM).toFixed(2)}m onto the DEM datum (${demPoints} points)`;
    console.log(
      `  session ${session.id}: ${session.samples} samples -> ${matchedRuns} runs merged, ${discardedRuns} discarded, ${anchor}`,
    );
  }

  await client.query("commit");
} catch (err) {
  await client.query("rollback");
  throw err;
} finally {
  client.release();
}

const { rows: summary } = await pool.query(
  `select count(*)::int as buckets,
          count(distinct segment_id)::int as segments,
          count(*) filter (where elevation_m < $1 or elevation_m > 3000)::int as implausible
     from segment_elevation_buckets`,
  [MIN_PLAUSIBLE_ELEVATION_M],
);

// --- why runs were discarded -------------------------------------------------
//
// A discard count alone cannot distinguish the two causes, which need opposite
// fixes. A run whose fragments together cover real ground is a traversal the
// matcher broke apart -- stitching them would recover it, with no change to any
// threshold. A run that stays short even after stitching genuinely only clipped
// the segment, and should stay rejected: those are the phantom lines.
if (allDiscards.length > 0) {
  const recoverable = allDiscards.filter((d) => d.stitchedWouldQualify);
  const genuine = allDiscards.filter((d) => !d.stitchedWouldQualify);

  console.log(`\n=== traversal gate: ${allDiscards.length} discarded runs ===`);
  const byKind = new Map<string, { kind: string; discarded: number; fragments: number; touches: number }>();
  for (const d of allDiscards) {
    const row = byKind.get(d.kind) ?? { kind: d.kind, discarded: 0, fragments: 0, touches: 0 };
    row.discarded += 1;
    if (d.stitchedWouldQualify) row.fragments += 1;
    else row.touches += 1;
    byKind.set(d.kind, row);
  }
  console.table([...byKind.values()].sort((a, b) => b.discarded - a.discarded));

  console.log(
    `recoverable by stitching fragments: ${recoverable.length}` +
      ` (${Math.round((100 * recoverable.length) / allDiscards.length)}%)`,
  );
  console.log(
    `genuine clips, correctly rejected:  ${genuine.length}` +
      ` (${Math.round((100 * genuine.length) / allDiscards.length)}%)`,
  );

  // If touches really are touches their spans should cluster near zero, which
  // is the evidence the 25m threshold was originally chosen on.
  const buckets = [0, 2, 5, 10, 15, 25];
  const histogram = buckets.map((lo, i) => {
    const hi = buckets[i + 1] ?? Infinity;
    const inBand = (rows: typeof allDiscards) =>
      rows.filter((d) => d.spanM >= lo && d.spanM < hi).length;
    return {
      span: hi === Infinity ? `${lo}m+` : `${lo}-${hi}m`,
      fragments: inBand(recoverable),
      touches: inBand(genuine),
    };
  });
  console.log("\nspan of each discarded run, before stitching:");
  console.table(histogram);

  // The stitching window has to come from here. Fragments of one traversal are
  // separated by a dropped fix or two; two separate crossings of the same block
  // are minutes apart. If those populations separate cleanly, the gap between
  // them is the window.
  const gapBands = [0, 5, 10, 20, 45, 90, 300];
  const gapHistogram = gapBands.map((lo, i) => {
    const hi = gapBands[i + 1] ?? Infinity;
    const inBand = (rows: typeof allDiscards) =>
      rows.filter((d) => d.gapToPreviousRunS != null && d.gapToPreviousRunS >= lo && d.gapToPreviousRunS < hi)
        .length;
    return {
      gap: hi === Infinity ? `${lo}s+` : `${lo}-${hi}s`,
      fragments: inBand(recoverable),
      touches: inBand(genuine),
    };
  });
  console.log("\ngap since the previous run on the same segment+direction:");
  console.table(gapHistogram);
  console.log(
    `first run on its segment (no previous, nothing to stitch to): ` +
      `${allDiscards.filter((d) => d.gapToPreviousRunS == null).length}`,
  );

  const worst = [...allDiscards]
    .filter((d) => d.stitchedWouldQualify)
    .sort((a, b) => b.stitchedSpanM - a.stitchedSpanM)
    .slice(0, 8)
    .map((d) => ({
      session: d.sessionId,
      street: d.streetName ?? "(unnamed)",
      kind: d.kind,
      dir: d.direction,
      seg_len: Math.round(d.segmentLengthM),
      this_run: Math.round(d.spanM),
      stitched: Math.round(d.stitchedSpanM),
      runs: d.runsOnSameSegment,
    }));
  if (worst.length > 0) {
    console.log("\nlargest traversals lost to fragmentation:");
    console.table(worst);
  }
}

console.log(`\nmerged ${totalMatched} runs, discarded ${totalDiscarded}`);
console.log(
  `model: ${summary[0].buckets} buckets across ${summary[0].segments} segments, ${summary[0].implausible} implausible`,
);

await pool.end();
