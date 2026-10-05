import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { bigintId, numericOrNull } from "./pgNumbers.js";

// Every fixture marked "from pg" is produced by node-postgres's OWN type parser
// for that column type, not typed in by hand. The bug this guards against is a
// mismatch between what the driver returns and what the code believes it
// returns, so a hand-written fixture would only test the belief.
const INT8 = 20;
const INT4 = 23;
const NUMERIC = 1700;
const FLOAT8 = 701;
const fromPg = (oid: number, text: string): unknown => pg.types.getTypeParser(oid)(text);

// What the driver runs on every query parameter before sending it. Exported at
// runtime as `pg.utils.prepareValue` but not declared in @types/pg, hence the
// narrow cast rather than an import the type checker would refuse.
const prepareValue = (pg as unknown as { utils: { prepareValue: (v: unknown) => unknown } })
  .utils.prepareValue;

// -- what the driver actually does, pinned -----------------------------------

test("THE PREMISE: pg returns bigint and numeric as strings, int and float as numbers", () => {
  // If a pg upgrade ever changes this, these fail first, and the comment at the
  // top of pgNumbers.ts needs revisiting before anything else does.
  assert.equal(fromPg(INT8, "84"), "84");
  assert.equal(fromPg(NUMERIC, "0.0164"), "0.0164");
  assert.equal(fromPg(INT4, "84"), 84);
  assert.equal(fromPg(FLOAT8, "0.0164"), 0.0164);
});

test("THE PREMISE the fix leans on downstream: a number and its text are the same query parameter", () => {
  // Converting a session id from "84" to 84 changes the value handed to every
  // query that takes it as a parameter -- processSession's two selects among
  // them. That is safe only because the driver serialises both identically.
  // Pinned, because an end-to-end replay was first offered as proof of this and
  // a cold review showed the replay could not fail: it passed even with the id
  // set to NaN, since traceSession uses the id only as a label.
  assert.equal(prepareValue(84), prepareValue("84"));
  assert.equal(prepareValue(84), "84");
});

test("the error message never throws while being built", () => {
  // An object holding a bigint makes JSON.stringify throw. pg cannot return
  // one, but a formatter that dies inside its own error path would replace a
  // clear message with an unrelated one.
  assert.throws(() => bigintId({ big: 1n }, "x"), /x: expected an integer id from the database, got \[object Object\]/);
});

// -- bigintId -----------------------------------------------------------------

test("a bigint id from pg becomes the number it names", () => {
  const id = bigintId(fromPg(INT8, "84"), "sessions.id");
  assert.equal(id, 84);
  assert.equal(typeof id, "number");
});

test("THE FAILURE IT EXISTS FOR: a converted id matches a Set of numbers, the raw one does not", () => {
  // evalLinkerFold's headline metric printed "n/a" for exactly this reason: a
  // Set<number> of session ids never matched the string the driver returned.
  const wanted = new Set([84]);
  const raw = fromPg(INT8, "84");
  assert.equal(wanted.has(raw as number), false, "the raw driver value really does miss");
  assert.equal(wanted.has(bigintId(raw, "sessions.id")), true);
});

test("an id already cast to int in SQL passes through unchanged", () => {
  assert.equal(bigintId(fromPg(INT4, "84"), "sessions.id"), 84);
});

test("a native bigint is accepted, in case the driver is ever configured to produce one", () => {
  assert.equal(bigintId(84n, "sessions.id"), 84);
  assert.equal(bigintId(BigInt(Number.MAX_SAFE_INTEGER), "id"), Number.MAX_SAFE_INTEGER);
});

test("BOUNDARY: the largest exact integer is accepted and the next one is refused", () => {
  assert.equal(bigintId(String(Number.MAX_SAFE_INTEGER), "id"), Number.MAX_SAFE_INTEGER);
  // 9007199254740993 rounds to ...992 as a double. Accepting it would let two
  // distinct ids collapse into one Map key without a word.
  assert.throws(() => bigintId(fromPg(INT8, "9007199254740993"), "id"), /not an integer/);
  assert.throws(() => bigintId(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "id"), /not an integer/);
});

test("an absurdly large bigint is refused with the field name, by the safe-integer check", () => {
  // Number(10n ** 400n) is Infinity, not an exception, so the one isSafeInteger
  // check covers every path. An earlier draft also range-checked the bigint
  // branch "to avoid a bare RangeError"; that error came only from a version
  // that called BigInt() on the converted value, which no longer exists. A cold
  // review deleted the pre-check, this test still passed, and it was dead code.
  assert.equal(Number(10n ** 400n), Number.POSITIVE_INFINITY);
  assert.throws(() => bigintId(10n ** 400n, "segments.id"), /segments\.id: .* not an integer/);
  assert.throws(() => bigintId(-(10n ** 400n), "segments.id"), /segments\.id/);
});

test("negative ids convert, because this checks representation, not the domain", () => {
  assert.equal(bigintId(fromPg(INT8, "-5"), "id"), -5);
});

test("THE JS TRAP: an empty string is refused, though Number('') is 0", () => {
  // A blank id coerced to 0 would quietly point at whatever row is id 0.
  assert.throws(() => bigintId("", "sessions.id"), /sessions\.id/);
});

test("anything Postgres would never emit for an int8 is refused, not coerced", () => {
  for (const bad of [" 84", "84 ", "1e3", "0x54", "84.0", "+84", "NaN", "Infinity", "8_4"]) {
    assert.throws(() => bigintId(bad, "id"), /id/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a non-integer number is refused", () => {
  assert.throws(() => bigintId(84.5, "id"), /not an integer/);
  assert.throws(() => bigintId(Number.NaN, "id"), /not an integer/);
  assert.throws(() => bigintId(Number.POSITIVE_INFINITY, "id"), /not an integer/);
});

test("null is refused: every id here is a primary or foreign key", () => {
  assert.throws(() => bigintId(null, "sessions.id"), /sessions\.id: expected an integer id/);
});

test("undefined is refused, which is what a misspelled column alias produces", () => {
  // `select s.id as sesion_id` then reading row.id gives undefined. Before this
  // it flowed on as an id and every lookup with it missed.
  assert.throws(() => bigintId(undefined, "sessions.id"), /got undefined/);
});

test("the message names the field and shows the bad value", () => {
  assert.throws(() => bigintId("abc", "segments.osm_way_id"), {
    message: 'segments.osm_way_id: expected an integer id from the database, got "abc"',
  });
});

// -- numericOrNull ------------------------------------------------------------

test("a numeric from pg becomes the number it names", () => {
  const share = numericOrNull(fromPg(NUMERIC, "0.0164"), "bad_share");
  assert.equal(share, 0.0164);
  assert.equal(typeof share, "number");
});

test("THE TRAP IN THIS FIELD: a zero share arrives as a TRUTHY string", () => {
  // avg() over numeric literals is numeric, so a ride with no bad steps comes
  // back as twenty zeros in a string, and any `if (share)` reads it as bad.
  const raw = fromPg(NUMERIC, "0.00000000000000000000");
  assert.equal(Boolean(raw), true, "the raw driver value really is truthy");
  const share = numericOrNull(raw, "bad_share");
  assert.equal(share, 0);
  assert.equal(Boolean(share), false);
});

test("SQL NULL stays null, because an aggregate over no rows is a real answer", () => {
  assert.equal(numericOrNull(null, "bad_share"), null);
});

test("an already-finite number passes through, so a later ::float8 cast changes nothing", () => {
  assert.equal(numericOrNull(fromPg(FLOAT8, "0.0164"), "bad_share"), 0.0164);
  assert.equal(numericOrNull(0, "bad_share"), 0);
});

test("negative and integer-valued numerics convert", () => {
  assert.equal(numericOrNull(fromPg(NUMERIC, "-12.5"), "x"), -12.5);
  assert.equal(numericOrNull(fromPg(NUMERIC, "3"), "x"), 3);
});

test("NaN and Infinity are legal numerics and are refused anyway", () => {
  // Postgres numeric genuinely supports both. No quantity stored in one here
  // may be either, and a NaN share would pass every comparison as false.
  assert.throws(() => numericOrNull(fromPg(NUMERIC, "NaN"), "bad_share"), /bad_share/);
  assert.throws(() => numericOrNull("Infinity", "bad_share"), /bad_share/);
  assert.throws(() => numericOrNull(Number.NaN, "bad_share"), /not a finite number/);
  assert.throws(() => numericOrNull(Number.NEGATIVE_INFINITY, "bad_share"), /not a finite/);
});

test("a numeric too LARGE for a double is refused, not turned into Infinity", () => {
  // Legal numeric text that passes the pattern. The first version checked
  // finiteness only on the number branch, so this came out as Infinity -- the
  // value the function's own doc said it refused. Found by a cold review.
  const huge = "1" + "0".repeat(400);
  assert.equal(Number(huge), Number.POSITIVE_INFINITY);
  assert.throws(() => numericOrNull(huge, "bad_share"), /bad_share: .* not a finite number/);
  assert.throws(() => numericOrNull("-" + huge, "bad_share"), /not a finite number/);
});

test("a numeric too SMALL for a double rounds to zero, on purpose", () => {
  // The other end of the same lossy conversion, accepted: it is the nearest
  // double, and no quantity here can tell 1e-401 from 0. Pinned so the choice
  // is visible rather than accidental.
  assert.equal(numericOrNull("0." + "0".repeat(400) + "1", "x"), 0);
});

test("THE JS TRAP again: an empty string is refused, not read as zero", () => {
  assert.throws(() => numericOrNull("", "bad_share"), /bad_share/);
});

test("undefined is refused rather than mistaken for NULL", () => {
  // A missing column and a NULL value are different failures. Treating
  // undefined as null would turn a broken query into "no data" silently.
  assert.throws(() => numericOrNull(undefined, "bad_share"), /got undefined/);
});

test("formats Postgres never emits for numeric are refused", () => {
  for (const bad of [" 1", "1 ", "1e-3", ".5", "5.", "+1", "0x1", "1,5"]) {
    assert.throws(() => numericOrNull(bad, "x"), /x/, `accepted ${JSON.stringify(bad)}`);
  }
});
