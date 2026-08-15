import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const inPath = path.resolve(process.argv[2] ?? "data/segments.geojson");
const geojson = JSON.parse(fs.readFileSync(inPath, "utf8"));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let inserted = 0;
for (const feature of geojson.features) {
  const { osmWayId, kind, streetName, startNodeId, endNodeId, pieceIndex, lengthM, bearingDeg } =
    feature.properties;
  await pool.query(
    `insert into segments
       (osm_way_id, kind, street_name, start_node_id, end_node_id, piece_index, geom, length_m, bearing_deg)
     values ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_GeomFromGeoJSON($7), 4326), $8, $9)
     on conflict (osm_way_id, start_node_id, end_node_id, piece_index) do update set
       kind = excluded.kind,
       street_name = excluded.street_name,
       geom = excluded.geom,
       length_m = excluded.length_m,
       bearing_deg = excluded.bearing_deg`,
    [
      osmWayId,
      kind,
      streetName,
      startNodeId,
      endNodeId,
      pieceIndex ?? 0,
      JSON.stringify(feature.geometry),
      lengthM,
      bearingDeg,
    ],
  );
  inserted++;
}

console.log(`loaded ${inserted} segments`);
await pool.end();
