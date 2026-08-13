import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const inPath = path.resolve(process.argv[2] ?? "data/segments.geojson");
const geojson = JSON.parse(fs.readFileSync(inPath, "utf8"));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let inserted = 0;
for (const feature of geojson.features) {
  const { osmWayId, streetName, startNodeId, endNodeId, lengthM, bearingDeg } = feature.properties;
  await pool.query(
    `insert into segments (osm_way_id, street_name, start_node_id, end_node_id, geom, length_m, bearing_deg)
     values ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), $6, $7)
     on conflict (osm_way_id, start_node_id, end_node_id) do update set
       geom = excluded.geom, length_m = excluded.length_m, bearing_deg = excluded.bearing_deg`,
    [osmWayId, streetName, startNodeId, endNodeId, JSON.stringify(feature.geometry), lengthM, bearingDeg],
  );
  inserted++;
}

console.log(`loaded ${inserted} segments into ${process.env.DATABASE_URL ? "database" : "(no DATABASE_URL set)"}`);
await pool.end();
