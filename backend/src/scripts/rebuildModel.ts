import "dotenv/config";
import { pool } from "../db/pool.js";
import { processSession } from "../services/sessionProcessor.js";

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

const dryRun = process.argv.includes("--dry-run");

const { rows: sessions } = await pool.query<{
  id: number;
  samples: number;
  min_elev: number | null;
  usable: boolean;
}>(
  `select s.id,
          count(ss.id)::int as samples,
          min(ss.elevation_m) as min_elev,
          coalesce(min(ss.elevation_m) >= $1, false) as usable
     from sessions s
     left join session_samples ss on ss.session_id = s.id
    group by s.id
    having count(ss.id) > 0
    order by s.id`,
  [MIN_PLAUSIBLE_ELEVATION_M],
);

const usable = sessions.filter((s) => s.usable);
const skipped = sessions.filter((s) => !s.usable);

console.log(`sessions with samples: ${sessions.length}`);
for (const s of skipped) {
  console.log(`  skipping session ${s.id}: min elevation ${s.min_elev?.toFixed(1)}m is not absolute`);
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
try {
  await client.query("begin");
  // One transaction, so a failure part way through leaves the existing model
  // untouched rather than a half-rebuilt one.
  await client.query("delete from session_segment_matches");
  await client.query("delete from segment_elevation_buckets");

  for (const session of usable) {
    const { matchedRuns, discardedRuns, demOffsetM, demPoints } = await processSession(
      client,
      session.id,
    );
    totalMatched += matchedRuns;
    totalDiscarded += discardedRuns;
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

console.log(`\nmerged ${totalMatched} runs, discarded ${totalDiscarded}`);
console.log(
  `model: ${summary[0].buckets} buckets across ${summary[0].segments} segments, ${summary[0].implausible} implausible`,
);

await pool.end();
