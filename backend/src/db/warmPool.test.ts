import { test } from "node:test";
import assert from "node:assert/strict";
import { warmPool } from "./warmPool.js";

// A pool whose connections the test counts: how many were asked for at once,
// and how many came back.
function fakePool(fails: number[] = []) {
  let asked = 0;
  let inFlight = 0;
  let mostAtOnce = 0;
  const released: number[] = [];
  return {
    released,
    get asked() {
      return asked;
    },
    get mostAtOnce() {
      return mostAtOnce;
    },
    connect: async () => {
      const n = asked++;
      inFlight += 1;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (fails.includes(n)) throw new Error(`connection ${n} refused`);
      return { release: () => released.push(n) };
    },
  };
}

test("it opens the connections all at once and hands every one back", async () => {
  const pool = fakePool();
  const result = await warmPool(pool, 4);
  assert.equal(pool.asked, 4);
  assert.equal(pool.mostAtOnce, 4, "at once: one at a time would reuse a single connection");
  assert.deepEqual(pool.released.sort(), [0, 1, 2, 3]);
  assert.deepEqual({ opened: result.opened, failed: result.failed }, { opened: 4, failed: [] });
  assert.ok(result.ms >= 0);
});

test("a connection that fails is reported, not thrown, and the ones that opened still go back", async () => {
  const pool = fakePool([1, 3]);
  const result = await warmPool(pool, 4);
  assert.deepEqual(pool.released.sort(), [0, 2]);
  assert.deepEqual({ opened: result.opened, failed: result.failed }, {
    opened: 2,
    failed: ["connection 1 refused", "connection 3 refused"],
  });
});
