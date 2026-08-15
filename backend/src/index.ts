import "dotenv/config";
import cors from "cors";
import express from "express";
import { segmentsRouter } from "./routes/segments.js";
import { sessionsRouter } from "./routes/sessions.js";

const app = express();
app.use(cors());
// Default express.json() body limit is 100kb -- a multi-minute ride's worth
// of samples uploaded in one batch (see mobile's uploadSamples) easily
// exceeds that, causing every upload to fail with a silently-swallowed 413
// in a release build (no LogBox to surface it).
app.use(express.json({ limit: "10mb" }));

app.use("/sessions", sessionsRouter);
app.use("/segments", segmentsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`backend listening on :${port}`);
});
