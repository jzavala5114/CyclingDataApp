import type { RequestHandler } from "express";
import { traceOf } from "./requestTrace.js";

// Access log. Rides intermittently fail to save with the phone reporting
// "/sessions/:id/samples timed out after 20s", and there was no way to tell
// whether the server never received that upload or received it and lost the
// reply -- nothing recorded a request's duration or even its arrival. Measured
// from outside, the same 51KB chunk answers in ~0.8-1.2s, so a 20s timeout is
// the phone's uplink rather than the server; this is what will prove it.
//
// Registered *before* express.json() on purpose (index.ts). A stalled upload
// stalls while its body is being read, which happens inside the body parser --
// timing from after it would miss exactly the case worth measuring.
//
// Logs on "close" rather than "finish" so an abandoned request is recorded
// too: `writableFinished` is false when the client gave up mid-flight, which
// is the signature of a phone hitting its timeout. Content-length says how
// much was meant to arrive, which separates a stalled upload from a slow query.
//
// The line ends with the request's trace (requestTrace.ts): the pool as the
// request found it, the connections it opened, the stages its route timed,
// and when the response was handed over in full. npm run split:access-log
// reads it back.
export const accessLog: RequestHandler = (req, res, next) => {
  // /health is polled by Railway and by every deploy check, and its timing can
  // be measured from outside whenever it is wanted. Logging it would bury the
  // ride traffic this exists to capture.
  if (req.path === "/health") return next();
  const trace = traceOf(res);
  res.on("finish", () => trace.finished());
  res.on("close", () => {
    const bytes = req.headers["content-length"];
    console.log(
      [
        req.method,
        req.originalUrl,
        res.writableFinished ? res.statusCode : `${res.statusCode} ABORTED-BY-CLIENT`,
        `${Math.round(trace.elapsedMs())}ms`,
        bytes ? `${bytes}B` : "",
        trace.logFields(),
      ]
        .filter(Boolean)
        .join(" "),
    );
  });
  next();
};
