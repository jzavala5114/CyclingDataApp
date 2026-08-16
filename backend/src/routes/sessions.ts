import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { processSession } from "../services/sessionProcessor.js";

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
// folds the results into the persistent elevation model.
sessionsRouter.post("/:id/end", async (req, res) => {
  const sessionId = Number(req.params.id);

  const client = await pool.connect();
  let result;
  try {
    await client.query("begin");
    result = await processSession(client, sessionId);
    await client.query(`update sessions set ended_at = now() where id = $1`, [sessionId]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }

  res.status(200).json(result);
});
