import "dotenv/config";
import { pool } from "../db/pool.js";
import { processSession, type DiscardedRun } from "../services/sessionProcessor.js";
import {
  isUsable,
  loadSessionVerdicts,
  whySkipped,
  MIN_PLAUSIBLE_ELEVATION_M,
} from "../services/usableSessions.js";

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

const dryRun = process.argv.includes("--dry-run");

// Which rides qualify, and why, lives in services/usableSessions.ts so that
// anything measuring the model agrees with the model about what went into it.
const sessions = await loadSessionVerdicts(pool);
const usable = sessions.filter(isUsable);
const skipped = sessions.filter((s) => !isUsable(s));

console.log(`sessions with samples: ${sessions.length}`);
for (const s of skipped) {
  console.log(`  skipping session ${s.id} (${s.samples} samples): ${whySkipped(s)}`);
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
// How many rides got a sliding anchor versus the old single number. A run where
// nothing ramps means the guards are rejecting every fit, which is a silent way
// for this to do nothing at all.
let totalRamped = 0;
let totalFlat = 0;
const allDiscards: Array<DiscardedRun & { sessionId: number }> = [];
try {
  await client.query("begin");
  // One transaction, so a failure part way through leaves the existing model
  // untouched rather than a half-rebuilt one.
  await client.query("delete from session_segment_matches");
  await client.query("delete from segment_coverage");
  await client.query("delete from segment_elevation_buckets");

  for (const session of usable) {
    const { matchedRuns, discardedRuns, demOffsetM, demDriftM, demAnchorShape, demPoints,
            rejectedSpikes, discards } = await processSession(client, session.id);
    totalMatched += matchedRuns;
    totalDiscarded += discardedRuns;
    totalSpikes += rejectedSpikes;
    if (demAnchorShape === "ramp") totalRamped += 1;
    else if (demAnchorShape === "constant") totalFlat += 1;
    for (const discard of discards) allDiscards.push({ ...discard, sessionId: session.id });
    // demOffsetM is (ours - DEM); the correction applied is its negation.
    // The drift is how far the ride was seen to slide across the stretch its
    // own revisits covered, which a single-number anchor could not express and
    // silently smeared across the whole ride instead.
    const drift =
      demDriftM != null && demAnchorShape === "ramp"
        ? `, sliding ${demDriftM >= 0 ? "+" : ""}${demDriftM.toFixed(2)}m over the measured stretch`
        : "";
    const anchor =
      demOffsetM == null
        ? "unanchored"
        : `shifted ${(-demOffsetM).toFixed(2)}m onto the DEM datum (${demPoints} points)${drift}`;
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
  `anchors: ${totalRamped} rides corrected with a sliding offset, ${totalFlat} with a single number`,
);
console.log(
  `model: ${summary[0].buckets} buckets across ${summary[0].segments} segments, ${summary[0].implausible} implausible`,
);

await pool.end();
