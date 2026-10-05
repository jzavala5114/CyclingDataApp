import { test } from "node:test";
import assert from "node:assert/strict";
import pg, { type Pool } from "pg";
import {
  loadSessionVerdicts,
  isUsable,
  whySkipped,
  MAX_IMPLAUSIBLE_STEP_SHARE,
} from "./usableSessions.js";

// `loadSessionVerdicts` decides which rides the model learns from, and 13
// scripts consume what it returns. Its `id` was typed `number` and arrived as
// text for the whole life of the project, because the generic on `db.query<T>`
// is an assertion the driver never sees. These tests feed it rows built by
// node-postgres's OWN type parsers, so they exercise what the driver returns
// rather than what the interface claims.

const INT8 = 20;
const INT4 = 23;
const NUMERIC = 1700;
const FLOAT8 = 701;
const parse = (oid: number, text: string | null): unknown =>
  text === null ? null : pg.types.getTypeParser(oid)(text);

/** One row exactly as the driver hands it back for this query's column types. */
const driverRow = ({
  id = "84",
  samples = "1367",
  minElev = "1843.2",
  badShare = "0.01640000000000000000" as string | null,
  labelled = "1367",
  scaleOk = true,
  plausibleOk = true,
} = {}) => ({
  id: parse(INT8, id), //                  s.id                       bigserial
  samples: parse(INT4, samples), //         count(ss.id)::int          int
  min_elev: parse(FLOAT8, minElev), //      min(elevation_m)           double precision
  bad_share: parse(NUMERIC, badShare), //   max(avg(case ... 1.0 ...)) numeric
  labelled: parse(INT4, labelled), //       count(...)::int            int
  scale_ok: scaleOk,
  plausible_ok: plausibleOk,
});

/** A stand-in for the pool that returns fixed rows, and records what was asked. */
const fakeDb = (rows: unknown[]) => {
  const calls: { text: string; values: unknown[] }[] = [];
  const db = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows };
    },
  };
  return { db: db as unknown as Pool, calls };
};

test("THE BUG: the session id comes back a number, not the text the driver returns", async () => {
  const { db } = fakeDb([driverRow({ id: "84" })]);
  const [verdict] = await loadSessionVerdicts(db);
  assert.equal(verdict!.id, 84);
  assert.equal(typeof verdict!.id, "number");
});

test("THE FAILURE IT CAUSED: a verdict id now matches a Set<number> of session ids", async () => {
  // evalLinkerFold kept a Set<number> of sessions to measure. Against the raw
  // text id it never matched, so `transitions` stayed 0 and the headline metric
  // printed "n/a". Nothing threw.
  const { db } = fakeDb([driverRow({ id: "56" }), driverRow({ id: "84" })]);
  const verdicts = await loadSessionVerdicts(db);
  const measure = new Set([56, 84]);
  assert.equal(verdicts.filter((v) => measure.has(v.id)).length, 2);
});

test("THE SECOND LIE: bad_share comes back a number, and a zero share is falsy", async () => {
  const { db } = fakeDb([
    driverRow({ id: "1", badShare: "0.01640000000000000000" }),
    driverRow({ id: "2", badShare: "0.00000000000000000000" }),
  ]);
  const [some, none] = await loadSessionVerdicts(db);
  assert.equal(some!.bad_share, 0.0164);
  assert.equal(typeof some!.bad_share, "number");
  // The driver returns this as a non-empty string, which is TRUTHY. A perfect
  // ride would read as a bad one to any `if (bad_share)`.
  assert.equal(none!.bad_share, 0);
  assert.equal(Boolean(none!.bad_share), false);
});

test("a ride too short to have a single step keeps bad_share null", async () => {
  // The aggregate runs over no rows, so SQL returns NULL. That is an answer --
  // "nothing to judge" -- and plausible_ok's coalesce relies on it.
  const { db } = fakeDb([driverRow({ badShare: null })]);
  const [verdict] = await loadSessionVerdicts(db);
  assert.equal(verdict!.bad_share, null);
});

test("every field the driver already returns correctly passes through untouched", async () => {
  const { db } = fakeDb([driverRow({ samples: "1367", minElev: "1843.2", labelled: "12" })]);
  const [verdict] = await loadSessionVerdicts(db);
  assert.deepEqual(verdict, {
    id: 84,
    samples: 1367,
    min_elev: 1843.2,
    bad_share: 0.0164,
    labelled: 12,
    scale_ok: true,
    plausible_ok: true,
  });
});

test("row order is the query's order, one verdict per row", async () => {
  const { db } = fakeDb([driverRow({ id: "5" }), driverRow({ id: "6" }), driverRow({ id: "84" })]);
  assert.deepEqual((await loadSessionVerdicts(db)).map((v) => v.id), [5, 6, 84]);
});

test("a malformed id fails LOUDLY with the column named, instead of flowing on as an id", async () => {
  // A renamed column alias reads as undefined; before this it became the id of
  // every verdict and every lookup with it missed.
  const { db } = fakeDb([{ ...driverRow(), id: undefined }]);
  await assert.rejects(loadSessionVerdicts(db), /sessions\.id: expected an integer id/);
});

test("a missing bad_share column fails loudly, and is not mistaken for a NULL share", async () => {
  // A misspelled alias reads as undefined. Read as NULL it would not change
  // which rides are used -- plausible_ok is computed inside the SQL, from the
  // column itself -- but whySkipped would explain a ride rejected for being 20%
  // spikes as "0.0% of its steps", a wrong reason printed in the rebuild log. A
  // cold review added `?? null` at this call site and every test still passed;
  // this is the test that was missing.
  const { db } = fakeDb([{ ...driverRow(), bad_share: undefined }]);
  await assert.rejects(loadSessionVerdicts(db), /bad_share: .* got undefined/);
});

test("a NaN share from numeric fails loudly instead of failing every comparison quietly", async () => {
  const { db } = fakeDb([driverRow({ badShare: "NaN" })]);
  await assert.rejects(loadSessionVerdicts(db), /bad_share/);
});

test("the thresholds are passed to the query in the order its placeholders expect", async () => {
  const { db, calls } = fakeDb([]);
  await loadSessionVerdicts(db);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.values[2], MAX_IMPLAUSIBLE_STEP_SHARE);
  assert.match(calls[0]!.text, /\$3/);
});

test("no sessions is an empty list, not an error", async () => {
  const { db } = fakeDb([]);
  assert.deepEqual(await loadSessionVerdicts(db), []);
});

// -- the consumers of a converted verdict -------------------------------------

test("whySkipped reports the share as a percentage", async () => {
  // This passes with the original bug restored too, and that is the point of
  // keeping it: `"0.207" * 100` coerces, which is exactly why the text-typed
  // share went unnoticed here for the life of the project. It checks the
  // output format, not the conversion -- the tests above check the conversion.
  const { db } = fakeDb([driverRow({ badShare: "0.20700000000000000000" })]);
  const [verdict] = await loadSessionVerdicts(db);
  assert.match(whySkipped(verdict!), /^20\.7% of its steps imply a gradient past/);
});

test("whySkipped on a scale failure names the elevation, not the share", async () => {
  const { db } = fakeDb([driverRow({ minElev: "-12.4", scaleOk: false })]);
  const [verdict] = await loadSessionVerdicts(db);
  assert.equal(isUsable(verdict!), false);
  assert.match(whySkipped(verdict!), /^min elevation -12\.4m is not absolute/);
});

test("isUsable needs both tests to pass", async () => {
  const { db } = fakeDb([
    driverRow({ id: "1", scaleOk: true, plausibleOk: true }),
    driverRow({ id: "2", scaleOk: false, plausibleOk: true }),
    driverRow({ id: "3", scaleOk: true, plausibleOk: false }),
  ]);
  assert.deepEqual((await loadSessionVerdicts(db)).filter(isUsable).map((v) => v.id), [1]);
});
