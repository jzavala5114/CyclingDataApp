import "dotenv/config";
import { pool } from "../db/pool.js";

// Deletes sessions that recorded nothing: no samples, no segment matches.
//
// These accumulate from pressing start and stopping again -- a mis-tap, or a
// test that the button works -- and from the older client, which asked the
// server for a session before recording anything, so a start that failed or was
// abandoned left the row behind. The current client only creates a session once
// there is a ride worth saving, so this is mostly a broom for what came before.
//
// Dry run unless --apply is passed.
//
//   npm run build && node dist/scripts/pruneEmptySessions.js
//   npm run build && node dist/scripts/pruneEmptySessions.js --apply

interface EmptySession {
  id: string;
  started_at: string;
  ended_at: string | null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  // A session is only a candidate if BOTH child tables are empty. Matches are
  // checked as well as samples because a merged session is not deletable in any
  // meaningful sense: the buckets are running means, so its contribution cannot
  // be subtracted back out, and removing the row would only erase the record of
  // where those numbers came from.
  const { rows: empty } = await pool.query<EmptySession>(
    `select s.id, s.started_at, s.ended_at
       from sessions s
      where not exists (select 1 from session_samples x where x.session_id = s.id)
        and not exists (select 1 from session_segment_matches m where m.session_id = s.id)
      order by s.id`,
  );

  if (empty.length === 0) {
    console.log("no empty sessions found");
  } else {
    console.log(`${empty.length} empty session(s)${apply ? "" : " (dry run)"}:`);
    console.table(empty);
    if (apply) {
      const { rowCount } = await pool.query(`delete from sessions where id = any($1::bigint[])`, [
        empty.map((r) => r.id),
      ]);
      console.log(`deleted ${rowCount}`);
    } else {
      console.log("re-run with --apply to delete these");
    }
  }

  // Reported, never deleted: these hold real GPS samples. A session can land
  // here legitimately -- riding somewhere with no imported segments, or a ride
  // too short to clear the traversal gate -- so it is a list to look at, not a
  // list to act on.
  const { rows: unmatched } = await pool.query(
    `select s.id, s.started_at, s.ended_at,
            (select count(*)::int from session_samples x where x.session_id = s.id) as samples
       from sessions s
      where exists (select 1 from session_samples x where x.session_id = s.id)
        and not exists (select 1 from session_segment_matches m where m.session_id = s.id)
      order by s.id`,
  );
  if (unmatched.length > 0) {
    console.log("\nsessions with samples but no matches (kept -- review by hand):");
    console.table(unmatched);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
