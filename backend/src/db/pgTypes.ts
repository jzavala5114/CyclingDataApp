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
// pg's text parser when set false. And a client asks its own `types` first,
// if it was given any, and when set to binary has every query pg prepares
// (any with parameters) answered in binary, where pg's binary int8 parser
// returns text. So pool.ts asks `driverReplaced` (the registry) and
// `clientReplaced` (the client a checkout hands out) on every checkout, which
// every pool.query is, and refuses the checkout with the reason. A replacement
// made while a client is already checked out reaches that client's later
// queries until it is released; the next checkout refuses. Parsers or binary
// given to a single query never reach a checkout. db/pool.test.ts holds all of
// that, fails if pool.ts stops importing this module, and scans every source
// file, in the spellings its comment lists, for pg's Pool or Client reached
// outside pool.ts or re-exported, a property `types` or `binary` given to
// anything (one query's config included), a parser registered, or
// `parseInt8`. A name assembled at runtime is beyond it.

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

/** Which of the two parsers a lookup no longer finds. */
const replacedIn = (parserFor: (oid: TypeId) => unknown): string[] =>
  [
    parserFor(INT8) === int8FromText ? null : "int8 (20)",
    parserFor(INT8_ARRAY) === int8ArrayFromText ? null : "int8[] (1016)",
  ].filter((name): name is string => name !== null);

/** Why the registry would not deliver ids through the parsers above, or null when it would. */
export function driverReplaced(): string | null {
  const replaced = replacedIn((oid) => pg.types.getTypeParser(oid, "text"));
  if (replaced.length === 0) return null;
  return (
    `the driver's ${replaced.join(" and ")} parser is no longer the one db/pgTypes.ts installed, ` +
    "so ids would arrive as text or rounded. Something replaced it: setTypeParser, or pg.defaults.parseInt8"
  );
}

/**
 * The same question for one client, which is what a query really reads with:
 * pg asks the client's own `types` before the registry, and a client set to
 * binary has every query with parameters answered in binary, which pg parses
 * with its own binary int8 parser (text) and never with the parsers above.
 */
export function clientReplaced(client: pg.ClientBase): string | null {
  // Truthy, as pg reads it (`c.binary || defaults.binary`, then `if (this.binary)`):
  // a cold review's `binary ||= 1` passed a test for `=== true`.
  if ((client as unknown as { binary?: unknown }).binary) {
    return (
      "a checked-out client asks for binary results, so every query with parameters would read int8 " +
      "through pg's binary parser, as text: pg.defaults.binary, or binary in the Pool's config"
    );
  }
  const replaced = replacedIn((oid) => client.getTypeParser(oid, "text"));
  if (replaced.length === 0) return null;
  return (
    `a checked-out client's ${replaced.join(" and ")} parser is not the one db/pgTypes.ts installed: ` +
    "the Pool or the client was given types of its own, so ids would arrive as text or rounded"
  );
}
