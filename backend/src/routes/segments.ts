import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { asyncRoute } from "./asyncRoute.js";
import { segmentsWithLines } from "../services/segmentsResponse.js";
import type { ElevationBucket, PassBucket, Segment, SegmentCoverage } from "../types/index.js";

export const segmentsRouter = Router();

const bboxSchema = z.object({
  minLon: z.coerce.number(),
  minLat: z.coerce.number(),
  maxLon: z.coerce.number(),
  maxLat: z.coerce.number(),
});

// Returns the segments in the viewport that have recorded elevation data,
// each with its directional gradient lines.
//
// Segments with no data render nothing, and the network spans a whole city,
// so returning all of them would ship tens of thousands of unusable rows per
// viewport. Filtering here keeps the response proportional to how much has
// actually been ridden rather than how much map is loaded.
segmentsRouter.get("/", asyncRoute(async (req, res) => {
  const { minLon, minLat, maxLon, maxLat } = bboxSchema.parse(req.query);

  const { rows: segmentRows } = await pool.query<Segment>(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            piece_index as "pieceIndex",
            ST_AsGeoJSON(geom)::json as geom, length_m as "lengthM", bearing_deg as "bearingDeg"
       from segments s
      where s.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        and s.canonical_segment_id is null
        and exists (select 1 from segment_elevation_buckets b where b.segment_id = s.id)`,
    [minLon, minLat, maxLon, maxLat],
  );

  if (segmentRows.length === 0) return res.json({ segments: [] });

  // The three below need only the segments' ids, so they go out together.
  // Each is a round trip to the database, and one after another they added up:
  // the fourth, the pass rows, would otherwise have made every map request a
  // round trip slower than before it existed.
  const ids = segmentRows.map((s) => s.id);
  const [{ rows: bucketRows }, { rows: coverageRows }, { rows: passRows }] = await Promise.all([
    pool.query<ElevationBucket>(
      `select segment_id as "segmentId", direction, distance_m as "distanceM",
              elevation_m as "elevationM", sample_count as "sampleCount"
         from segment_elevation_buckets
        where segment_id = any($1)`,
      [ids],
    ),
    pool.query<SegmentCoverage>(
      `select segment_id as "segmentId", direction,
              covered_from_m as "coveredFromM", covered_to_m as "coveredToM"
         from segment_coverage
        where segment_id = any($1)`,
      [ids],
    ),
    // Each pass's own heights, which the slopes are fitted to wherever every
    // pass behind a window is on file (services/gradientBuilder.ts). Found
    // through the match rows, which carry the segment and direction.
    pool.query<PassBucket>(
      `select m.segment_id as "segmentId", m.direction, p.match_id as "matchId",
              p.distance_m as "distanceM", p.elevation_m as "elevationM"
         from segment_pass_buckets p
         join session_segment_matches m on m.id = p.match_id
        where m.segment_id = any($1)`,
      [ids],
    ),
  ]);

  // Joined in services/segmentsResponse.ts, which says why that join is fragile.
  res.json({ segments: segmentsWithLines(segmentRows, bucketRows, coverageRows, passRows) });
}));
