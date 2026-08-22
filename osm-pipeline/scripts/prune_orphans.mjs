import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Deletes segments that the current extract no longer produces.
//
// load_segments.mjs upserts on (osm_way_id, start_node_id, end_node_id,
// piece_index), so it can only ever add or update -- it has no way to know that
// a row it wrote last time is now obsolete. That matters whenever the fetch
// bbox grows: a segment boundary is "a node shared by two or more kept ways",
// so a newly imported way touching an existing one turns that node into an
// intersection and splits the old way differently. The new pieces arrive under
// new keys and the old, longer piece stays behind.
//
// Left alone those leftovers are real geometry sitting on top of the real road.
// The matcher would see two candidates a metre apart for the same tarmac and
// scatter a single ride between them -- the same failure that separately-mapped
// sidewalks used to cause.
//
// Run after load_segments.mjs and BEFORE link_canonical.mjs: deleting a road
// sets its sidewalks' canonical_segment_id back to null (on delete set null),
// which would promote them to standalone routes drawing their own lines.
// Linking afterwards re-points whatever survives.
//
// Dry run unless --apply is passed.
//
//   DATABASE_URL=... node scripts/prune_orphans.mjs
//   DATABASE_URL=... node scripts/prune_orphans.mjs --apply

const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const inPath = path.resolve(fileArg ?? "data/segments.geojson");
const apply = process.argv.includes("--apply");

const geojson = JSON.parse(fs.readFileSync(inPath, "utf8"));
console.log(`${geojson.features.length} segments in ${path.basename(inPath)}`);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
await client.query("set statement_timeout = '10min'");

const ORPHAN_PREDICATE = `not exists (
  select 1 from current_keys k
   where k.osm_way_id    = s.osm_way_id
     and k.start_node_id = s.start_node_id
     and k.end_node_id   = s.end_node_id
     and k.piece_index   = s.piece_index
)`;

const BATCH = 2000;
const COLUMNS = 4;

try {
  await client.query("begin");

  // A temp table plus an anti-join, rather than a 66k-element NOT IN list:
  // the planner handles the join with an index, and the parameter list stays
  // inside Postgres' limit.
  await client.query(
    `create temp table current_keys (
       osm_way_id bigint, start_node_id bigint, end_node_id bigint, piece_index integer
     ) on commit drop`,
  );

  for (let start = 0; start < geojson.features.length; start += BATCH) {
    const batch = geojson.features.slice(start, start + BATCH);
    const values = [];
    const tuples = batch.map((feature, i) => {
      const p = feature.properties;
      values.push(p.osmWayId, p.startNodeId, p.endNodeId, p.pieceIndex ?? 0);
      const n = i * COLUMNS;
      return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4})`;
    });
    await client.query(`insert into current_keys values ${tuples.join(", ")}`, values);
    process.stdout.write(`\r  indexed ${Math.min(start + BATCH, geojson.features.length)}`);
  }
  await client.query(
    `create index on current_keys (osm_way_id, start_node_id, end_node_id, piece_index)`,
  );
  await client.query(`analyze current_keys`);

  const { rows: summary } = await client.query(
    `select count(*)::int as orphans,
            count(*) filter (where exists (
              select 1 from segment_elevation_buckets b where b.segment_id = s.id))::int as with_buckets,
            count(*) filter (where s.canonical_segment_id is null)::int as canonical
       from segments s
      where ${ORPHAN_PREDICATE}`,
  );
  console.log(`\n`);
  console.table(summary);

  // A sample, so an unexpectedly large number can be eyeballed before deleting.
  const { rows: sample } = await client.query(
    `select s.id, s.street_name, round(s.length_m::numeric, 1) as length_m, s.piece_index
       from segments s where ${ORPHAN_PREDICATE}
      order by s.length_m desc limit 8`,
  );
  if (sample.length > 0) {
    console.log("longest orphans:");
    console.table(sample);
  }

  if (apply) {
    const { rowCount } = await client.query(`delete from segments s where ${ORPHAN_PREDICATE}`);
    await client.query("commit");
    console.log(`deleted ${rowCount} orphaned segments`);
  } else {
    await client.query("rollback");
    console.log("dry run -- nothing deleted. Re-run with --apply.");
  }
} catch (err) {
  await client.query("rollback");
  throw err;
} finally {
  client.release();
  await pool.end();
}
