import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import pg from "pg";
// Production's driver: pool.ts loads db/pgTypes.ts. The query is faked, but
// the row below is built by that driver's own int8 parser.
import { pool } from "../db/pool.js";
import { sessionsRouter } from "./sessions.js";

// POST /sessions as the phone receives it. The id it returns is the one the
// phone files every later upload under, and the int8 parser changed it from
// "84" to 84 on the wire. mobile/src/services/api.ts (startSession) types it
// `number`. A cold review made this route send it back as text, and no test
// noticed: none covered the route.

const int8 = (text: string) => pg.types.getTypeParser(pg.types.builtins.INT8, "text")(text) as number;

test("the driver in this file is production's: a bigint is a number", () => {
  assert.equal(int8("84"), 84);
});

test("POST /sessions answers 201 with the new id as a JSON NUMBER and the start time as ISO text", async (t) => {
  const startedAt = "2026-10-08T12:00:00.000Z";
  const calls: { text: string; values: unknown[] }[] = [];
  t.mock.method(pool, "query", (async (text: string, values: unknown[]) => {
    calls.push({ text, values });
    return { rows: [{ id: int8("84"), started_at: new Date(startedAt) }] };
  }) as never);

  const server = express().use(express.json()).use("/sessions", sessionsRouter).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startedAt }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 84, started_at: startedAt });
  } finally {
    server.close();
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /insert into sessions/);
  assert.deepEqual(calls[0]!.values, [startedAt]);
});
