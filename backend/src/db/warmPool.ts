// Opens `count` connections at once and hands them back to the pool, so the
// first press after a deploy finds them waiting instead of paying 400 to
// 850ms for each (db/pool.ts, `min`). The server calls it once it is
// listening, with the pool's min. A connection that fails to open is
// reported, not thrown: the server answers without it, and the next request
// opens what it needs. Every connection that did open goes back to the pool.
interface Connects {
  connect(): Promise<{ release(): void }>;
}

export async function warmPool(db: Connects, count: number): Promise<{ opened: number; failed: string[]; ms: number }> {
  const t0 = performance.now();
  const results = await Promise.allSettled(Array.from({ length: count }, () => db.connect()));
  const failed: string[] = [];
  let opened = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      result.value.release();
      opened += 1;
    } else {
      failed.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }
  return { opened, failed, ms: performance.now() - t0 };
}
