// What a request spent its time on: the database pool as the request found it,
// the connections opened while it ran, and each stage a route names, as
// offsets in ms from its arrival. The access log (accessLog.ts) appends it to
// the request's line; GET /segments/path also sends its stages in a
// Server-Timing header (https://www.w3.org/TR/server-timing/), which
// eval:latency reads and the phone ignores.
//
// Added 2026-10-18 for the lag's last open case: some presses after a quiet
// spell took 762 to 1023ms on the server against 263 to 294ms for the rest,
// and a press downtown 1.4 to 1.6s after minutes without one, and the access
// log's single number could not say whether that time went to the database,
// to opening connections, or to handing the answer over to Railway's proxy.
import type { Response } from "express";
import { pool } from "../db/pool.js";

// What the pool holds now, and how many connections it has opened since the
// process started, read as a request arrives and again as it ends: a slow
// request says whether it found connections waiting or had to open its own.
// Counted here, not in db/pool.ts, which hands out the pool and nothing else.
export interface PoolSnapshot {
  total: number;
  idle: number;
  waiting: number;
  opened: number;
}
let opened = 0;
pool.on("connect", () => {
  opened += 1;
});
export const poolSnapshot = (): PoolSnapshot => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
  opened,
});

interface Stage {
  name: string;
  fromMs: number;
  toMs: number;
}

const whole = (ms: number) => Math.round(ms);

export class RequestTrace {
  private readonly startedAt = performance.now();
  private readonly stages: Stage[] = [];
  private finishedMs: number | null = null;
  readonly arrival: PoolSnapshot;

  constructor(private readonly snapshot: () => PoolSnapshot = poolSnapshot) {
    this.arrival = snapshot();
  }

  elapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  // A stage that waits: from when its work was handed over until it settles,
  // so stages run in parallel each keep their own span.
  async time<T>(name: string, work: Promise<T>): Promise<T> {
    const fromMs = this.elapsedMs();
    try {
      return await work;
    } finally {
      this.stages.push({ name, fromMs, toMs: this.elapsedMs() });
    }
  }

  timeSync<T>(name: string, work: () => T): T {
    const fromMs = this.elapsedMs();
    try {
      return work();
    } finally {
      this.stages.push({ name, fromMs, toMs: this.elapsedMs() });
    }
  }

  // A stage of plain statements: from where the last stage ended (or the
  // arrival) to now.
  mark(name: string): void {
    const fromMs = this.stages.reduce((end, stage) => Math.max(end, stage.toMs), 0);
    this.stages.push({ name, fromMs, toMs: this.elapsedMs() });
  }

  // When the response had been handed to the operating system in full: the
  // access log calls it on the response's "finish".
  finished(): void {
    this.finishedMs ??= this.elapsedMs();
  }

  private opened(): number {
    return this.snapshot().opened - this.arrival.opened;
  }

  // Each stage's duration, the time so far, and the pool. Sent before the
  // body, so it cannot hold the answer's own serializing or delivery: those
  // are in the access log line.
  serverTiming(): string {
    const a = this.arrival;
    return [
      ...this.stages.map((s) => `${s.name};dur=${(s.toMs - s.fromMs).toFixed(1)}`),
      `total;dur=${this.elapsedMs().toFixed(1)}`,
      `pool;desc="idle ${a.idle} of ${a.total} waiting ${a.waiting} opened ${this.opened()}"`,
    ].join(", ");
  }

  // For the access log: pool=idle/total/waiting on arrival, opened=N during
  // the request, then name=from-to for each stage and finish=ms.
  logFields(): string {
    const a = this.arrival;
    const fields = [`pool=${a.idle}/${a.total}/${a.waiting}`, `opened=${this.opened()}`];
    for (const s of this.stages) fields.push(`${s.name}=${whole(s.fromMs)}-${whole(s.toMs)}`);
    if (this.finishedMs !== null) fields.push(`finish=${whole(this.finishedMs)}`);
    return fields.join(" ");
  }
}

// The request's trace, which the access log starts on arrival; a route mounted
// without the access log (its tests) gets one started here.
export function traceOf(res: Response): RequestTrace {
  const locals = res.locals as { trace?: RequestTrace };
  return (locals.trace ??= new RequestTrace());
}
