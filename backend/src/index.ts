import "dotenv/config";
import { readFileSync } from "node:fs";
import cors from "cors";
import express from "express";
import { segmentsRouter } from "./routes/segments.js";
import { sessionsRouter } from "./routes/sessions.js";

const app = express();
app.use(cors());

// Access log. Rides intermittently fail to save with the phone reporting
// "/sessions/:id/samples timed out after 20s", and there was no way to tell
// whether the server never received that upload or received it and lost the
// reply -- nothing recorded a request's duration or even its arrival. Measured
// from outside, the same 51KB chunk answers in ~0.8-1.2s, so a 20s timeout is
// the phone's uplink rather than the server; this is what will prove it.
//
// Registered *before* express.json() on purpose. A stalled upload stalls while
// its body is being read, which happens inside the body parser -- timing from
// after it would miss exactly the case worth measuring.
//
// Logs on "close" rather than "finish" so an abandoned request is recorded
// too: `writableFinished` is false when the client gave up mid-flight, which
// is the signature of a phone hitting its timeout. Content-length says how
// much was meant to arrive, which separates a stalled upload from a slow query.
app.use((req, res, next) => {
  // /health is polled by Railway and by every deploy check, and its timing can
  // be measured from outside whenever it is wanted. Logging it would bury the
  // ride traffic this exists to capture.
  if (req.path === "/health") return next();
  const startedAt = Date.now();
  res.on("close", () => {
    const bytes = req.headers["content-length"];
    console.log(
      [
        req.method,
        req.originalUrl,
        res.writableFinished ? res.statusCode : `${res.statusCode} ABORTED-BY-CLIENT`,
        `${Date.now() - startedAt}ms`,
        bytes ? `${bytes}B` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  });
  next();
});

// Default express.json() body limit is 100kb -- a multi-minute ride's worth
// of samples uploaded in one batch (see mobile's uploadSamples) easily
// exceeds that, causing every upload to fail with a silently-swallowed 413
// in a release build (no LogBox to surface it).
app.use(express.json({ limit: "10mb" }));

app.use("/sessions", sessionsRouter);
app.use("/segments", segmentsRouter);

// Written by `npm run build` into dist/. This is the only cheap way to tell
// which build is actually answering: during a Railway rollout the service
// reports Online and /health returns ok while the *old* container is still
// serving every request, so neither is evidence that a deploy landed. A
// timestamp that changes with the image is.
const BUILT_AT = (() => {
  try {
    const raw = readFileSync(new URL("./buildInfo.json", import.meta.url), "utf8");
    return JSON.parse(raw).builtAt as string;
  } catch {
    return "unknown";
  }
})();

app.get("/health", (_req, res) => res.json({ ok: true, builtAt: BUILT_AT }));

// Express 4 does not catch rejections from async handlers, so a throw inside
// one becomes an unhandled rejection -- which Node treats as fatal. A single
// bad request therefore killed the whole backend: one duplicate-key error took
// the process down mid-upload, and Railway restarted into the same fate on the
// next retry. Handlers pass errors here through asyncRoute() instead.
app.use(
  (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Log the message and stack, never the error object. body-parser attaches
    // the entire unparsed payload to its errors as `err.body`, so logging the
    // object dumped a whole ride's GPS trace into the logs -- 260KB on one line
    // when this was tested. Nothing downstream needs that, and it buries every
    // other line in the retention window.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`request failed ${req.method} ${req.originalUrl}: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    if (res.headersSent) return;
    res.status(500).json({ error: message });
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
