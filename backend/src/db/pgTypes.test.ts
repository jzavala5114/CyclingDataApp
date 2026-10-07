import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// pgTypes.ts works by side effect on node-postgres's process-wide parser table,
// so this file controls exactly when that happens. It reads pg's own defaults
// FIRST, then imports the module, and every test after that sees the driver as
// production configures it. Nothing here imports pgTypes.ts statically, and
// nothing imported here reaches db/pool.ts, which would load it early.

type Parse = (text: string) => unknown;
type TypeId = Parameters<typeof pg.types.getTypeParser>[0];

const INT8 = pg.types.builtins.INT8;
const INT8_ARRAY = 1016 as TypeId;
const NUMERIC = pg.types.builtins.NUMERIC;
const parser = (oid: TypeId): Parse => pg.types.getTypeParser(oid, "text") as Parse;

const pgDefault = { int8: parser(INT8), int8Array: parser(INT8_ARRAY), numeric: parser(NUMERIC) };

await import("./pgTypes.js");

const int8 = parser(INT8);
const int8Array = parser(INT8_ARRAY);

// -- the premise, observed before the module ran -------------------------------

test("THE PREMISE: pg's own default returns bigint as text, in arrays too", () => {
  // If a pg upgrade changes this, the module may be unnecessary, or may be
  // fighting a parser that already returns something else. Either way this
  // fails first.
  assert.equal(pgDefault.int8("84"), "84");
  assert.deepEqual(pgDefault.int8Array("{1,NULL}"), ["1", null]);
  assert.equal(pgDefault.numeric("0.0164"), "0.0164");
});

// -- what importing it changes ------------------------------------------------

test("a bigint becomes the number it names", () => {
  assert.equal(int8("84"), 84);
  assert.equal(typeof int8("84"), "number");
  assert.equal(int8("-5"), -5);
});

test("THE FAILURE IT EXISTS FOR: a bucket filed under a converted id is found by a converted id", () => {
  // routes/segments.ts files buckets under ElevationBucket.segmentId and looks
  // them up by Segment.id. Both are int8 columns from separate queries. One
  // parser converts both, so the lookup holds; converting one side and not the
  // other is a miss on every segment, which ships every street with an empty
  // profile and throws nothing. Shown here so the property is pinned, not assumed.
  const filed = new Map([[int8("745"), "buckets"]]);
  assert.equal(filed.get(int8("745")), "buckets");
  assert.equal(filed.get(pgDefault.int8("745") as number), undefined, "a half-converted join misses");
});

test("BOUNDARY: the largest exact integer is accepted and the next one throws", () => {
  assert.equal(int8(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  // 9007199254740993 rounds to ...992 as a double: two ids would become one key.
  assert.throws(() => int8("9007199254740993"), /a bigint column: "9007199254740993" is not an integer/);
});

test("int8 arrays convert element by element, keeping NULLs and nesting", () => {
  assert.deepEqual(int8Array("{1,NULL,9007199254740991}"), [1, null, Number.MAX_SAFE_INTEGER]);
  assert.deepEqual(int8Array("{{1,2},{3,4}}"), [[1, 2], [3, 4]]);
  assert.deepEqual(int8Array("{}"), []);
});

test("an int8 array holding an unsafe element throws rather than rounding it", () => {
  assert.throws(() => int8Array("{1,9007199254740993}"), /not an integer a JS number can hold exactly/);
});

test("numeric is deliberately untouched: still text", () => {
  // usableSessions' bad_share depends on this staying a converter's job: its
  // NULL means "nothing to judge" and its Infinity must be refused.
  assert.equal(parser(NUMERIC)("0.0164"), "0.0164");
});

test("a Client built with no type options uses it, which is what every Pool client is", () => {
  const client = new pg.Client();
  assert.equal(client.getTypeParser(INT8)("7"), 7);
});

test("THROUGH pg's OWN ROW PARSING: an unsafe id fails that query, it does not crash the process", () => {
  // A parser runs inside pg's socket handler. If its throw escaped, one bad row
  // would take the server down. pg catches it in Query.handleDataRow and hands
  // it to the query's callback instead; pinned here against pg's real Query.
  type Driven = {
    handleRowDescription(msg: { fields: { name: string; dataTypeID: number; format: string }[] }): void;
    handleDataRow(msg: { fields: (string | null)[] }): void;
    handleReadyForQuery(connection: unknown): void;
  };
  const results: { err: Error | null; rows?: unknown[] }[] = [];
  const run = (text: string | null) => {
    const query = new pg.Query({ text: "select id", types: pg.types }, undefined) as unknown as Driven & {
      callback: (err: Error | null, res?: { rows: unknown[] }) => void;
    };
    query.callback = (err, res) => results.push({ err, rows: res?.rows });
    query.handleRowDescription({ fields: [{ name: "id", dataTypeID: INT8, format: "text" }] });
    query.handleDataRow({ fields: [text] });
    query.handleReadyForQuery({});
  };

  run("84");
  run(null);
  run("9007199254740993");

  assert.deepEqual(results[0], { err: null, rows: [{ id: 84 }] });
  // SQL NULL never reaches a parser: pg hands back null itself.
  assert.deepEqual(results[1], { err: null, rows: [{ id: null }] });
  assert.match(String(results[2]!.err), /a bigint column: "9007199254740993" is not an integer/);
  assert.equal(results[2]!.rows, undefined);
});
