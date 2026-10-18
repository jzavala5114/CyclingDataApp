import type { Pool } from "pg";
import { drawLine, drawnExtent } from "./gradientBuilder.js";
import { lineKey, type Extent, type LineData, type Transition } from "./pathGrowth.js";
import type { Direction, ElevationBucket, PassBucket, Segment, SegmentCoverage } from "../types/index.js";

// What a press-and-hold path reads from the database, read the same way by
// GET /segments/path and by `npm run eval:path`, so the eval measures what the
// route serves. Every statement here only reads.

/** The pool, or one client checked out of it. */
export type Db = Pick<Pool, "query">;

export interface Box {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const M_PER_DEG_LAT = 111_320;

/** The box around `points`, padded by `padM` metres on every side. */
export function boxAround(points: ReadonlyArray<readonly number[]>, padM: number): Box {
  const lons = points.map((p) => p[0]!);
  const lats = points.map((p) => p[1]!);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLat = padM / M_PER_DEG_LAT;
  const padLon = padM / (M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180));
  return {
    minLon: Math.min(...lons) - padLon,
    minLat: Math.min(...lats) - padLat,
    maxLon: Math.max(...lons) + padLon,
    maxLat: Math.max(...lats) + padLat,
  };
}

/** Whether a point lies `marginM` or more inside the box. */
export function insideBox(box: Box, marginM: number): (point: readonly number[]) => boolean {
  const inner = boxAround(
    [
      [box.minLon, box.minLat],
      [box.maxLon, box.maxLat],
    ],
    -marginM,
  );
  return ([lon, lat]) => lon! >= inner.minLon && lon! <= inner.maxLon && lat! >= inner.minLat && lat! <= inner.maxLat;
}

// The canonical segments in a box, and every other slice of any capped run
// that has a slice in it. buildEndAdjacency tells a run's real ends from its
// 150m cuts by the slices' piece_index, so a family cut short by the box edge
// would make its last loaded cut look like the run's end node, and join it to
// the cross street hundreds of metres away. Sidewalks are left out, as the
// matcher leaves them out: they are drawn as their road.
export async function loadSegmentsInBox(db: Db, box: Box): Promise<Segment[]> {
  const { rows } = await db.query<Segment>(
    `with boxed as (
       select osm_way_id, least(start_node_id, end_node_id) as lo, greatest(start_node_id, end_node_id) as hi
         from segments
        where geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          and canonical_segment_id is null
     )
     select distinct on (s.id)
            s.id, s.osm_way_id as "osmWayId", s.kind, s.street_name as "streetName",
            s.start_node_id as "startNodeId", s.end_node_id as "endNodeId", s.piece_index as "pieceIndex",
            ST_AsGeoJSON(s.geom)::json as geom, s.length_m as "lengthM", s.bearing_deg as "bearingDeg"
       from boxed b
       join segments s
         on s.osm_way_id = b.osm_way_id
        and least(s.start_node_id, s.end_node_id) = b.lo
        and greatest(s.start_node_id, s.end_node_id) = b.hi
      where s.canonical_segment_id is null
      order by s.id`,
    [box.minLon, box.minLat, box.maxLon, box.maxLat],
  );
  return rows;
}

// Every line among `segments` with something drawn, and the stretch drawn:
// drawnExtent over the first and last bucket and the recorded coverage, the
// same inputs the map draws from.
export async function loadExtents(db: Db, segments: readonly Segment[]): Promise<Map<string, Extent>> {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const { rows } = await db.query<{
    segmentId: number;
    direction: Direction;
    firstBucketM: number;
    lastBucketM: number;
    coveredFromM: number | null;
    coveredToM: number | null;
  }>(
    `select b.segment_id as "segmentId", b.direction,
            min(b.distance_m) as "firstBucketM", max(b.distance_m) as "lastBucketM",
            c.covered_from_m as "coveredFromM", c.covered_to_m as "coveredToM"
       from segment_elevation_buckets b
       left join segment_coverage c on c.segment_id = b.segment_id and c.direction = b.direction
      where b.segment_id = any($1)
      group by b.segment_id, b.direction, c.covered_from_m, c.covered_to_m`,
    [segments.map((s) => s.id)],
  );
  const extents = new Map<string, Extent>();
  for (const row of rows) {
    const segment = byId.get(row.segmentId);
    if (!segment) continue;
    const coverage =
      row.coveredFromM === null || row.coveredToM === null
        ? undefined
        : { segmentId: row.segmentId, direction: row.direction, coveredFromM: row.coveredFromM, coveredToM: row.coveredToM };
    const extent = drawnExtent(segment.lengthM, row.firstBucketM, row.lastBucketM, coverage);
    if (extent) extents.set(lineKey(row), { fromM: extent.fromTravelM, toM: extent.toTravelM });
  }
  return extents;
}

// Every ride's stored lines in the order it rode them, as pairs: each match
// row and the next one in the same session, by the time of their first fixes.
// The next stored line is not always the next one ridden, since a run the gate
// threw away leaves no row; growth only ever asks about a pair that touches.
export async function loadTransitions(db: Db): Promise<Transition[]> {
  const { rows } = await db.query<{
    sessionId: number;
    segmentId: number;
    direction: Direction;
    nextSegmentId: number;
    nextDirection: Direction;
  }>(
    `select session_id as "sessionId", segment_id as "segmentId", direction,
            next_segment_id as "nextSegmentId", next_direction as "nextDirection"
       from (select m.session_id, m.segment_id, m.direction,
                    lead(m.segment_id) over w as next_segment_id,
                    lead(m.direction) over w as next_direction
               from session_segment_matches m
               join session_samples f on f.id = m.first_sample_id
             window w as (partition by m.session_id order by f.recorded_at, m.id)) t
      where next_segment_id is not null`,
  );
  return rows.map((r) => ({
    sessionId: r.sessionId,
    from: { segmentId: r.segmentId, direction: r.direction },
    to: { segmentId: r.nextSegmentId, direction: r.nextDirection },
  }));
}

/** The rides behind a line's data. */
export interface LineRides {
  rides: number;
  lastRiddenAt: Date;
}

// Everything the map draws for each line of `segmentIds`, both directions,
// and the rides behind it. The bucket, coverage and pass queries are the three
// GET /segments makes, so a path draws each line exactly as the map does.
export async function loadLineData(
  db: Db,
  segments: ReadonlyMap<number, Segment>,
  segmentIds: readonly number[],
): Promise<{ lines: Map<string, LineData>; rides: Map<string, LineRides> }> {
  const ids = [...new Set(segmentIds)];
  const [{ rows: bucketRows }, { rows: coverageRows }, { rows: passRows }, { rows: rideRows }] = await Promise.all([
    db.query<ElevationBucket>(
      `select segment_id as "segmentId", direction, distance_m as "distanceM",
              elevation_m as "elevationM", sample_count as "sampleCount"
         from segment_elevation_buckets
        where segment_id = any($1)`,
      [ids],
    ),
    db.query<SegmentCoverage>(
      `select segment_id as "segmentId", direction,
              covered_from_m as "coveredFromM", covered_to_m as "coveredToM"
         from segment_coverage
        where segment_id = any($1)`,
      [ids],
    ),
    db.query<PassBucket>(
      `select m.segment_id as "segmentId", m.direction, p.match_id as "matchId",
              p.distance_m as "distanceM", p.elevation_m as "elevationM"
         from segment_pass_buckets p
         join session_segment_matches m on m.id = p.match_id
        where m.segment_id = any($1)`,
      [ids],
    ),
    db.query<{ segmentId: number; direction: Direction; rides: number; lastRiddenAt: Date }>(
      `select m.segment_id as "segmentId", m.direction,
              count(distinct m.session_id)::int as rides, max(s.started_at) as "lastRiddenAt"
         from session_segment_matches m
         join sessions s on s.id = m.session_id
        where m.segment_id = any($1)
        group by m.segment_id, m.direction`,
      [ids],
    ),
  ]);

  const group = <T extends { segmentId: number; direction: Direction }>(rows: readonly T[]) => {
    const byLine = new Map<string, T[]>();
    for (const row of rows) {
      const key = lineKey(row);
      const list = byLine.get(key);
      if (list) list.push(row);
      else byLine.set(key, [row]);
    }
    return byLine;
  };
  const bucketsByLine = group(bucketRows);
  const passesByLine = group(passRows);
  const coverageByLine = new Map(coverageRows.map((c) => [lineKey(c), c]));

  const lines = new Map<string, LineData>();
  for (const [key, buckets] of bucketsByLine) {
    const { segmentId, direction } = buckets[0]!;
    const segment = segments.get(segmentId);
    if (!segment) continue;
    const drawing = drawLine(segment, direction, buckets, coverageByLine.get(key), passesByLine.get(key));
    if (drawing) lines.set(key, { drawing, buckets: [...buckets].sort((a, b) => a.distanceM - b.distanceM) });
  }
  const rides = new Map(rideRows.map((r) => [lineKey(r), { rides: r.rides, lastRiddenAt: r.lastRiddenAt }]));
  return { lines, rides };
}
