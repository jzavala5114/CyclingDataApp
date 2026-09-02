import "dotenv/config";
import { pool } from "../db/pool.js";
import { processSession, type DiscardedRun } from "../services/sessionProcessor.js";
import { MAX_PLAUSIBLE_GRADE_PCT } from "../services/elevationSmoothing.js";

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

// How much of a ride may be physically impossible before the ride itself is
// the problem. Individual bad fixes are dropped by rejectElevationSpikes(); a
// ride whose bad fixes are not the exception is not worth reprocessing around.
//
// **This replaced a median-roughness test, and the reasons are worth keeping.**
// That test claimed to detect rides recorded on GPS altitude rather than the
// barometer, sorting the archive into bands at 0.35-0.49m, 0.69-0.89m and
// 1.48-6.39m of median absolute second difference. Both halves of it failed.
//
// The premise is wrong: GPS altitude quantises to 0.1m and holds its value
// across fixes -- 53.9% of session 61's readings repeat the one before -- so it
// reads *smoother* than a working barometer, not rougher. Labelled data shows
// GPS session 56 at 0.259m against barometer session 62 at 0.564m. The bands
// were sorting rides by terrain, not by sensor: the rough ones are the mountain
// trails.
//
// And a median cannot see a spike. Measured by the share of steps implying a
// gradient past MAX_PLAUSIBLE_GRADE_PCT, the old threshold excluded sessions 46
// (3.8%) and 50 (3.2%) while keeping session 54 at 6.6% -- nearly twice as bad
// as either. Across every ride only 178 steps of 10,820 are impossible, 1.6%,
// so throwing away three whole rides to reach some of them was the wrong unit.
//
// Session 45 is the one ride that genuinely fails: a *median* implied gradient
// of 41.5% and a 99th percentile of 408%, with 20.7% of its steps impossible.
// That is not a ride with spikes in it, it is a ride that is spikes. The next
// worst is 6.6%, so this sits in open space rather than being tuned.
//
// Rides carrying elevation_source are exempt -- once a ride says what it used,
// guessing from noise is strictly worse.
const MAX_IMPLAUSIBLE_STEP_SHARE = 0.15;

const dryRun = process.argv.includes("--dry-run");

const { rows: sessions } = await pool.query<{
  id: number;
  samples: number;
  min_elev: number | null;
  bad_share: number | null;
  labelled: number;
  scale_ok: boolean;
  plausible_ok: boolean;
}>(
  `with steps as (
     select session_id,
            abs(elevation_m - lag(elevation_m) over w)
              / nullif(st_distance(
                  st_setsrid(st_makepoint(lag(lon) over w, lag(lat) over w), 4326)::geography,
                  st_setsrid(st_makepoint(lon, lat), 4326)::geography), 0) * 100 as grade_pct,
            st_distance(
              st_setsrid(st_makepoint(lag(lon) over w, lag(lat) over w), 4326)::geography,
              st_setsrid(st_makepoint(lon, lat), 4326)::geography) as ground_m
       from session_samples
     window w as (partition by session_id order by recorded_at)
   ),
   implausible as (
     -- Steps shorter than a metre are mostly GPS jitter, and dividing by them
     -- turns an ordinary reading into an infinite gradient.
     select session_id,
            avg(case when grade_pct > $2 then 1.0 else 0.0 end) as bad_share
       from steps where grade_pct is not null and ground_m > 1 group by session_id
   )
   select s.id,
          count(ss.id)::int as samples,
          min(ss.elevation_m) as min_elev,
          max(i.bad_share) as bad_share,
          count(ss.elevation_source)::int as labelled,
          coalesce(min(ss.elevation_m) >= $1, false) as scale_ok,
          -- A labelled ride is trusted on its own account; an unlabelled one
          -- has to pass the plausibility test. A ride too short to have any
          -- step is let through on the scale test.
          (count(ss.elevation_source) > 0
             or coalesce(max(i.bad_share) <= $3, true)) as plausible_ok
     from sessions s
     left join session_samples ss on ss.session_id = s.id
     left join implausible i on i.session_id = s.id
    group by s.id
    having count(ss.id) > 0
    order by s.id`,
  [MIN_PLAUSIBLE_ELEVATION_M, MAX_PLAUSIBLE_GRADE_PCT, MAX_IMPLAUSIBLE_STEP_SHARE],
);

const usable = sessions.filter((s) => s.scale_ok && s.plausible_ok);
const skipped = sessions.filter((s) => !(s.scale_ok && s.plausible_ok));

console.log(`sessions with samples: ${sessions.length}`);
for (const s of skipped) {
  const why = !s.scale_ok
    ? `min elevation ${s.min_elev?.toFixed(1)}m is not absolute`
    : `${((s.bad_share ?? 0) * 100).toFixed(1)}% of its steps imply a gradient past ${MAX_PLAUSIBLE_GRADE_PCT}% — the ride is spikes, not a ride with spikes in it`;
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
let totalSpikes = 0;
const allDiscards: Array<DiscardedRun & { sessionId: number }> = [];
try {
  await client.query("begin");
  // One transaction, so a failure part way through leaves the existing model
  // untouched rather than a half-rebuilt one.
  await client.query("delete from session_segment_matches");
  await client.query("delete from segment_coverage");
  await client.query("delete from segment_elevation_buckets");

  for (const session of usable) {
    const { matchedRuns, discardedRuns, demOffsetM, demPoints, rejectedSpikes, discards } =
      await processSession(client, session.id);
    totalMatched += matchedRuns;
    totalDiscarded += discardedRuns;
    totalSpikes += rejectedSpikes;
    for (const discard of discards) allDiscards.push({ ...discard, sessionId: session.id });
    // demOffsetM is (ours - DEM); the correction applied is its negation.
    const anchor =
      demOffsetM == null
        ? "unanchored"
        : `shifted ${(-demOffsetM).toFixed(2)}m onto the DEM datum (${demPoints} points)`;
    const spikes = rejectedSpikes > 0 ? `, ${rejectedSpikes} spikes dropped` : "";
    console.log(
      `  session ${session.id}: ${session.samples} samples -> ${matchedRuns} runs merged, ${discardedRuns} discarded${spikes}, ${anchor}`,
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

console.log(
  `\nmerged ${totalMatched} runs, discarded ${totalDiscarded}, dropped ${totalSpikes} impossible fixes`,
);
console.log(
  `model: ${summary[0].buckets} buckets across ${summary[0].segments} segments, ${summary[0].implausible} implausible`,
);

await pool.end();
