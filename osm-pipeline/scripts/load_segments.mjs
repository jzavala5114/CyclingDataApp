import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const inPath = path.resolve(process.argv[2] ?? "data/segments.geojson");
const geojson = JSON.parse(fs.readFileSync(inPath, "utf8"));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// One round trip per segment is fine for a single neighborhood but crawls
// once the extract covers a whole city, so rows go up in batches.
const BATCH_SIZE = 500;
const COLUMNS = 11;

let inserted = 0;
for (let start = 0; start < geojson.features.length; start += BATCH_SIZE) {
  const batch = geojson.features.slice(start, start + BATCH_SIZE);
  const values = [];
  const tuples = batch.map((feature, i) => {
    const {
      osmWayId,
      kind,
      isSidewalk,
      isTunnel,
      streetName,
      startNodeId,
      endNodeId,
      pieceIndex,
      lengthM,
      bearingDeg,
    } = feature.properties;
    values.push(
      osmWayId,
      kind,
      isSidewalk ?? false,
      // A geojson written before the flag existed has no such property, and
      // `undefined` would be sent as null into a `not null` column. Absent
      // means "not known to be covered", which is what false says.
      isTunnel ?? false,
      streetName,
      startNodeId,
      endNodeId,
      pieceIndex ?? 0,
      JSON.stringify(feature.geometry),
      lengthM,
      bearingDeg,
    );
    const n = i * COLUMNS;
    return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}, ST_SetSRID(ST_GeomFromGeoJSON($${n + 9}), 4326), $${n + 10}, $${n + 11})`;
  });

  await pool.query(
    `insert into segments
       (osm_way_id, kind, is_sidewalk, is_tunnel, street_name, start_node_id, end_node_id, piece_index, geom, length_m, bearing_deg)
     values ${tuples.join(", ")}
     on conflict (osm_way_id, start_node_id, end_node_id, piece_index) do update set
       kind = excluded.kind,
       is_sidewalk = excluded.is_sidewalk,
       is_tunnel = excluded.is_tunnel,
       street_name = excluded.street_name,
       geom = excluded.geom,
       length_m = excluded.length_m,
       bearing_deg = excluded.bearing_deg`,
    values,
  );

  inserted += batch.length;
  process.stdout.write(`\r  loaded ${inserted}/${geojson.features.length}`);
}

console.log(`\nloaded ${inserted} segments`);
await pool.end();
