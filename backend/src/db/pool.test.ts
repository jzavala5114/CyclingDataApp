import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// The server and every script reach the database through db/pool.ts, and the
// only thing making their ids numbers is that pool.ts loads db/pgTypes.ts. Drop
// that import and production silently goes back to ids as text, which no other
// gate test would notice: the type tests import pgTypes.ts by name. So this
// file observes the driver, imports pool.ts and nothing else, and observes it
// again. Building the Pool opens no connection; that waits for the first query.

const int8 = (): unknown => pg.types.getTypeParser(pg.types.builtins.INT8, "text")("84");
const before = int8();
await import("./pool.js");

test("importing db/pool.ts is what makes a bigint arrive as a number", () => {
  assert.equal(before, "84", "nothing in this file configured the driver before pool.ts did");
  assert.equal(int8(), 84);
});
