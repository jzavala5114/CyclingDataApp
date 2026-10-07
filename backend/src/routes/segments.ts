import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { asyncRoute } from "./asyncRoute.js";
import { segmentsWithLines } from "../services/segmentsResponse.js";
import type { ElevationBucket, Segment, SegmentCoverage } from "../types/index.js";

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

  const { rows: bucketRows } = await pool.query<ElevationBucket>(
    `select segment_id as "segmentId", direction, distance_m as "distanceM",
            elevation_m as "elevationM", sample_count as "sampleCount"
       from segment_elevation_buckets
      where segment_id = any($1)`,
    [segmentRows.map((s) => s.id)],
  );

  const { rows: coverageRows } = await pool.query<SegmentCoverage>(
    `select segment_id as "segmentId", direction,
            covered_from_m as "coveredFromM", covered_to_m as "coveredToM"
       from segment_coverage
      where segment_id = any($1)`,
    [segmentRows.map((s) => s.id)],
  );

  // Joined in services/segmentsResponse.ts, which says why that join is fragile.
  res.json({ segments: segmentsWithLines(segmentRows, bucketRows, coverageRows) });
}));
