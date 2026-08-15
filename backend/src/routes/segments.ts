import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { buildDirectionalGradientLines } from "../services/gradientBuilder.js";
import type { Direction, ElevationBucket, Segment } from "../types/index.js";

export const segmentsRouter = Router();

const bboxSchema = z.object({
  minLon: z.coerce.number(),
  minLat: z.coerce.number(),
  maxLon: z.coerce.number(),
  maxLat: z.coerce.number(),
});

// Returns every segment in the viewport with its two directional gradient
// lines (empty colorStops if that direction has no data yet).
segmentsRouter.get("/", async (req, res) => {
  const { minLon, minLat, maxLon, maxLat } = bboxSchema.parse(req.query);

  const { rows: segmentRows } = await pool.query<Segment>(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            ST_AsGeoJSON(geom)::json as geom, length_m as "lengthM", bearing_deg as "bearingDeg"
       from segments
      where geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)`,
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

  const bucketsBySegment = new Map<number, Record<Direction, ElevationBucket[]>>();
  for (const bucket of bucketRows) {
    const forSegment = bucketsBySegment.get(bucket.segmentId) ?? { forward: [], backward: [] };
    forSegment[bucket.direction].push(bucket);
    bucketsBySegment.set(bucket.segmentId, forSegment);
  }

  const segments = segmentRows.map((segment) => ({
    id: segment.id,
    streetName: segment.streetName,
    geom: segment.geom,
    lengthM: segment.lengthM,
    directionalLines: buildDirectionalGradientLines(
      segment,
      bucketsBySegment.get(segment.id) ?? { forward: [], backward: [] },
    ),
  }));

  res.json({ segments });
});
