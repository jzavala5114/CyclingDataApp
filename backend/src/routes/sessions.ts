import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { asyncRoute } from "./asyncRoute.js";
import { processSession } from "../services/sessionProcessor.js";

export const sessionsRouter = Router();

// `startedAt` is optional because the phone no longer creates a session when
// the start button is pressed -- it records locally and only asks for a session
// once there is a ride worth keeping. By then "now" is the *end* of the ride,
// so the real start time has to travel with the request.
const createSchema = z.object({ startedAt: z.string().optional() });

sessionsRouter.post("/", asyncRoute(async (req, res) => {
  const { startedAt } = createSchema.parse(req.body ?? {});
  const { rows } = await pool.query(
    `insert into sessions (started_at)
     values (coalesce($1::timestamptz, now()))
     returning id, started_at`,
    [startedAt ?? null],
  );
  res.status(201).json(rows[0]);
}));

// Discards a session outright. Refused once the ride has been folded into the
// elevation model: the buckets are running means, so there is no subtracting a
// session back out of them, and deleting the row would leave its contribution
// behind with nothing left to record where it came from.
sessionsRouter.delete("/:id", asyncRoute(async (req, res) => {
  const sessionId = Number(req.params.id);
  const { rows } = await pool.query<{ matches: number }>(
    `select count(*)::int as matches from session_segment_matches where session_id = $1`,
    [sessionId],
  );
  if (rows[0].matches > 0) {
    return res.status(409).json({
      error: "session has already been merged into the elevation model",
      matches: rows[0].matches,
    });
  }
  // session_samples and session_segment_matches are declared `on delete
  // cascade`, so the child rows go with it.
  const { rowCount } = await pool.query(`delete from sessions where id = $1`, [sessionId]);
  res.status(200).json({ deleted: rowCount ?? 0 });
}));

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

// One INSERT per sample meant one round trip per sample, and the whole ride was
// uploaded inside a single transaction. A 28-minute ride is ~600 samples now
// that fixes are spaced by distance, so that was ~600 sequential round trips to
// Supabase with the transaction held open the entire time -- minutes of work
// that the phone, riding on mobile data, had no timeout to survive. When the
// connection went, the transaction rolled back and the ride landed as zero
// rows. Batched, the same upload is a couple of round trips.
const SAMPLE_INSERT_BATCH = 500;
const SAMPLE_COLUMNS = 8;

sessionsRouter.post("/:id/samples", asyncRoute(async (req, res) => {
  const sessionId = Number(req.params.id);
  const { samples } = uploadSchema.parse(req.body);

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (let start = 0; start < samples.length; start += SAMPLE_INSERT_BATCH) {
      const batch = samples.slice(start, start + SAMPLE_INSERT_BATCH);
      const values: unknown[] = [];
      const tuples = batch.map((s, i) => {
        values.push(sessionId, s.recordedAt, s.lat, s.lon, s.elevationM, s.headingDeg, s.speedMps, s.accuracyM);
        const n = i * SAMPLE_COLUMNS;
        return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8})`;
      });
      await client.query(
        `insert into session_samples
           (session_id, recorded_at, lat, lon, elevation_m, heading_deg, speed_mps, accuracy_m)
         values ${tuples.join(", ")}
         on conflict (session_id, recorded_at) do nothing`,
        values,
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
}));

// Ends the session, then map-matches its samples against nearby segments and
// folds the results into the persistent elevation model.
sessionsRouter.post("/:id/end", asyncRoute(async (req, res) => {
  const sessionId = Number(req.params.id);

  // Matching is not repeatable: buckets are running means, so folding a ride in
  // twice weights it double and cannot be undone. A phone that gives up waiting
  // and retries must not be able to cause that -- and it happened, because the
  // server finished a 35-minute ride's matching after the app had already timed
  // out and reported failure.
  const { rows: existing } = await pool.query<{
    endedAt: string | null;
    matches: number;
    samples: number;
  }>(
    `select ended_at as "endedAt",
            (select count(*)::int from session_segment_matches m where m.session_id = s.id) as matches,
            (select count(*)::int from session_samples x where x.session_id = s.id) as samples
       from sessions s where s.id = $1`,
    [sessionId],
  );
  if (existing.length > 0 && existing[0].endedAt != null) {
    return res.status(200).json({
      matchedRuns: existing[0].matches,
      discardedRuns: 0,
      demOffsetM: null,
      demPoints: 0,
      alreadyProcessed: true,
    });
  }

  // A session holding no samples has nothing to merge and nothing to show. Left
  // alone it becomes a permanent empty row -- one per mis-tap, one per test of
  // the start button. Drop it instead of ending it.
  if (existing.length > 0 && existing[0].samples === 0) {
    await pool.query(`delete from sessions where id = $1`, [sessionId]);
    return res.status(200).json({
      matchedRuns: 0,
      discardedRuns: 0,
      demOffsetM: null,
      demPoints: 0,
      discarded: true,
    });
  }

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

  // `discards` is rebuild-time diagnostics -- potentially dozens of rows per
  // ride, and of no use to the phone, so it is not sent.
  res.status(200).json({
    matchedRuns: result.matchedRuns,
    discardedRuns: result.discardedRuns,
    demOffsetM: result.demOffsetM,
    demPoints: result.demPoints,
  });
}));
