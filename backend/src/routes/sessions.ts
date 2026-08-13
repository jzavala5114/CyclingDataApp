import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { matchSamplesToSegments } from "../services/segmentMatcher.js";
import { mergeRunIntoElevationModel } from "../services/elevationAggregator.js";
import type { Segment, SessionSample } from "../types/index.js";

export const sessionsRouter = Router();

sessionsRouter.post("/", async (_req, res) => {
  const { rows } = await pool.query(
    `insert into sessions (started_at) values (now()) returning id, started_at`,
  );
  res.status(201).json(rows[0]);
});

const sampleSchema = z.object({
  recordedAt: z.string(),
  lat: z.number(),
  lon: z.number(),
  elevationM: z.number(),
  headingDeg: z.number().nullable().optional(),
  speedMps: z.number().nullable().optional(),
  accuracyM: z.number().nullable().optional(),
});

const uploadSchema = z.object({ samples: z.array(sampleSchema) });

sessionsRouter.post("/:id/samples", async (req, res) => {
  const sessionId = Number(req.params.id);
  const { samples } = uploadSchema.parse(req.body);

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const s of samples) {
      await client.query(
        `insert into session_samples
           (session_id, recorded_at, lat, lon, elevation_m, heading_deg, speed_mps, accuracy_m)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [sessionId, s.recordedAt, s.lat, s.lon, s.elevationM, s.headingDeg, s.speedMps, s.accuracyM],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }

  res.status(204).end();
});

// Ends the session, then map-matches its samples against nearby segments and
// folds the results into the persistent elevation model. Candidate segments
// are loaded from a bounding box around the session's own samples -- fine
// for a prototype where a session is one short ride.
sessionsRouter.post("/:id/end", async (req, res) => {
  const sessionId = Number(req.params.id);

  const { rows: sampleRows } = await pool.query<SessionSample>(
    `select id, session_id as "sessionId", recorded_at as "recordedAt", lat, lon,
            elevation_m as "elevationM", heading_deg as "headingDeg",
            speed_mps as "speedMps", accuracy_m as "accuracyM"
       from session_samples where session_id = $1 order by recorded_at`,
    [sessionId],
  );

  if (sampleRows.length === 0) {
    await pool.query(`update sessions set ended_at = now() where id = $1`, [sessionId]);
    return res.status(200).json({ matchedRuns: 0 });
  }

  const lats = sampleRows.map((s) => s.lat);
  const lons = sampleRows.map((s) => s.lon);
  const pad = 0.005; // ~500m
  const { rows: segmentRows } = await pool.query<Segment>(
    `select id, osm_way_id as "osmWayId", street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            ST_AsGeoJSON(geom)::json as geom, length_m as "lengthM", bearing_deg as "bearingDeg"
       from segments
      where geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)`,
    [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad],
  );

  const runs = matchSamplesToSegments(sampleRows, segmentRows);
  const segmentsById = new Map(segmentRows.map((s) => [s.id, s]));

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const run of runs) {
      const segment = segmentsById.get(run.segmentId);
      if (!segment) continue;
      await mergeRunIntoElevationModel(client, run, segment);
      await client.query(
        `insert into session_segment_matches
           (session_id, segment_id, direction, first_sample_id, last_sample_id)
         values ($1, $2, $3, $4, $5)`,
        [sessionId, run.segmentId, run.direction, run.samples[0].id, run.samples[run.samples.length - 1].id],
      );
    }
    await client.query(`update sessions set ended_at = now() where id = $1`, [sessionId]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }

  res.status(200).json({ matchedRuns: runs.length });
});
