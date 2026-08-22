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

// Express 4 does not catch rejections from async handlers, so a throw inside
// one becomes an unhandled rejection -- which Node treats as fatal. A single
// bad request therefore killed the whole backend: one duplicate-key error took
// the process down mid-upload, and Railway restarted into the same fate on the
// next retry. Handlers pass errors here through asyncRoute() instead.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("request failed", err);
    if (res.headersSent) return;
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  },
);

// Last line of defence. Something unhandled has still gone wrong, but staying
// up to serve the next request beats dropping every in-flight ride upload.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection", reason);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`backend listening on :${port}`);
});
