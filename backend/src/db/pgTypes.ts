import pg from "pg";
import { bigintId } from "./pgNumbers.js";

// Makes every `bigint` the database returns a JS number, for every query in the
// process, by replacing node-postgres's parser for the type.
//
// pg returns int8 as TEXT by default (pgNumbers.ts says why), and every id in
// schema.sql is int8, so every id arrived as "84" while nine fields in
// types/index.ts said `number`. Those ids are joined to each other: the
// /segments route files buckets and coverage under `ElevationBucket.segmentId`
// and `SegmentCoverage.segmentId`, then looks them up by `Segment.id`.
// Converting them query by query risks converting one side of a join and not
// the other, which ships every street with an empty profile and throws nothing.
// A parser converts every one of them at once, so they cannot get out of step.
//
// **It changes more than the ids.** Every int8 result becomes a number: an
// uncast `count(*)`, `sum()` over an int column, `row_number()`. `npm run
// eval:query-types` asks the database for the type of every column each query
// in backend/src returns and checks it against the type the code declares,
// under the driver as configured here. Its header says what it cannot read.
//
// An int8 too large to be exact throws rather than rounding (see bigintId), and
// pg turns a throwing parser into a rejected query, so the query that read it
// fails with the value in the message instead of two ids quietly becoming one.
//
// Int8 ARRAYS have a parser of their own, which returns text elements whatever
// the scalar parser does, so they are converted too. No query returns one today
// (`$1::bigint[]` appears only as a parameter), but `array_agg(id)` would
// otherwise be the one place an id still arrived as text.
//
// `numeric` stays text, deliberately. It is arbitrary precision. The numeric
// this backend computes with, `bad_share` in usableSessions.ts, is converted
// where it is read by numericOrNull, which knows what NULL and Infinity mean
// there; the only other, `len` in evalLinkerFold.ts, is only printed.
//
// Its own module so a test can configure the driver exactly as production does
// by importing it, without building a Pool. `db/pool.ts`, which builds the only
// Pool, imports it, so no query in the server or any script can run before it
// has.
//
// The registry it writes to is global, so anything later in the process can
// write over it: a stray setTypeParser, or pg's own `pg.defaults.parseInt8`
// switch, which installs int4's parseInt (rounds past 2^53) when set true and
// pg's text parser when set false. So `driverReplaced` says whether these are
// still the parsers in place, and pool.ts asks it on every checkout, which
// every query goes through: in any process, a replaced parser fails the query
// with the reason. db/pool.test.ts holds that, and also fails if pool.ts stops
// importing this module, or if any other source file builds a Pool or Client,
// brings its own parsers, registers one, or mentions `parseInt8`.

type TypeId = Parameters<typeof pg.types.getTypeParser>[0];

const INT8 = pg.types.builtins.INT8;
// Not in pg-types' TypeId enum, which lists only scalar types.
const INT8_ARRAY = 1016 as TypeId;

const LABEL = "a bigint column";

// Captured before it is replaced: the array SYNTAX (quoting, NULL, nesting) is
// pg's to parse. Only its elements are converted here.
const pgInt8Array = pg.types.getTypeParser(INT8_ARRAY, "text") as (text: string) => unknown;

const convertElements = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(convertElements) : value === null ? null : bigintId(value, LABEL);

/** The int8 parser: the number the text names, exactly, or a throw. */
export const int8FromText = (text: string): number => bigintId(text, LABEL);
/** The int8[] parser: pg's array syntax, each element through bigintId. */
export const int8ArrayFromText = (text: string): unknown => convertElements(pgInt8Array(text));

pg.types.setTypeParser(INT8, int8FromText);
pg.types.setTypeParser(INT8_ARRAY, int8ArrayFromText);

/** Why int8 values would not arrive through the parsers above, or null when they would. */
export function driverReplaced(): string | null {
  const replaced = [
    pg.types.getTypeParser(INT8, "text") === int8FromText ? null : "int8 (20)",
    pg.types.getTypeParser(INT8_ARRAY, "text") === int8ArrayFromText ? null : "int8[] (1016)",
  ].filter((name) => name !== null);
  if (replaced.length === 0) return null;
  return (
    `the driver's ${replaced.join(" and ")} parser is no longer the one db/pgTypes.ts installed, ` +
    "so ids would arrive as text or rounded. Something replaced it: setTypeParser, or pg.defaults.parseInt8"
  );
}
