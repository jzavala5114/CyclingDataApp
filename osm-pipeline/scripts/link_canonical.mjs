import pg from "pg";

// Points every sidewalk/cycleway segment at the road it runs alongside, so
// the matcher and the map treat a street and its sidewalks as one route.
//
// Run after load_segments.mjs. Done in PostGIS rather than in JS because the
// GiST index makes the proximity search cheap; the equivalent JS pass over
// 31k segments would be a naive O(n^2) scan.
//
// Only ways OSM explicitly tags `footway=sidewalk` are eligible. Proximity
// alone is not enough: trails such as Shooks Run, Midland and the Pikes Peak
// Greenway run beside a road for part of their length, and absorbing just
// those stretches cut them into disconnected pieces on the map.
//
// Among the eligible sidewalks, one counts as belonging to a road when it is
// within MAX_OFFSET_M and roughly parallel to it (either heading -- a
// sidewalk's digitised direction is arbitrary relative to the road's). A
// sidewalk with no road alongside keeps canonical_segment_id null.
const MAX_OFFSET_M = 20;
const MAX_BEARING_DELTA_DEG = 20;
// Cheap bounding-box prefilter that the GiST index on geom can serve. Casting
// straight to geography for every candidate pair instead makes the planner
// scan the whole table and blows the statement timeout.
const PREFILTER_DEG = 0.0004; // ~35m at this latitude, comfortably over MAX_OFFSET_M
const BATCH = 2000;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
await client.query("set statement_timeout = '10min'");

const { rows: bounds } = await client.query(
  `select min(id) as lo, max(id) as hi from segments where is_sidewalk`,
);
const lo = Number(bounds[0].lo);
const hi = Number(bounds[0].hi);

let linked = 0;
for (let start = lo; start <= hi; start += BATCH) {
  const { rowCount } = await client.query(
    `update segments f
        set canonical_segment_id = best.road_id
       from (
         select f2.id as path_id, r.id as road_id,
                row_number() over (
                  partition by f2.id
                  order by ST_Distance(f2.geom::geography, r.geom::geography)
                ) as rn
           from segments f2
           join segments r
             on r.kind = 'road'
            and r.geom && ST_Expand(f2.geom, $3)
            and ST_DWithin(f2.geom::geography, r.geom::geography, $4)
            and least(
                  abs(f2.bearing_deg - r.bearing_deg),
                  360 - abs(f2.bearing_deg - r.bearing_deg),
                  abs(abs(f2.bearing_deg - r.bearing_deg) - 180)
                ) < $5
          where f2.is_sidewalk
            -- A few stretches of named trail (Midland Trail) are tagged
            -- footway=sidewalk in OSM. If someone bothered to give a path a
            -- name that isn't itself "... sidewalk", treat it as a route in
            -- its own right rather than absorbing it into the road.
            and (f2.street_name is null or f2.street_name ilike '%sidewalk%')
            and f2.id >= $1 and f2.id < $2
       ) best
      where best.path_id = f.id and best.rn = 1`,
    [start, start + BATCH, PREFILTER_DEG, MAX_OFFSET_M, MAX_BEARING_DELTA_DEG],
  );
  linked += rowCount;
  process.stdout.write(`\r  linked ${linked} paths (ids ${start}..${Math.min(start + BATCH, hi)})`);
}

const { rows } = await client.query(
  `select kind, is_sidewalk,
          count(*) filter (where canonical_segment_id is null) as canonical,
          count(*) filter (where canonical_segment_id is not null) as merged_into_road
     from segments group by kind, is_sidewalk order by kind, is_sidewalk`,
);
console.log(`\nlinked ${linked} paths to a parent road`);
console.table(rows);

client.release();
await pool.end();
