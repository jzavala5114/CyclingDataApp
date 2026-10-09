import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import ts from "typescript";
import type { Column, ColumnType, Declared, Description, Kind, QuerySite, RowType } from "./evalQueryTypes.js";

// pg's own int8 parser, captured BEFORE the census module loads: it imports
// db/pool.ts, which replaces this parser for the whole process. The census has
// to be shown failing on the driver as it was, not only passing on the driver as
// it is, so both are held here, and the order is this file's decision.
const pgDefaultInt8 = pg.types.getTypeParser(pg.types.builtins.INT8, "text") as (text: string) => unknown;
const {
  DescribeStatement,
  configuredParser,
  declaredColumn,
  deliveredShape,
  describeAll,
  findQuerySites,
  judge,
  judgeCensus,
  kindOfValue,
  loadProgram,
  runCensus,
  showDeclared,
  unreadModules,
  withReadOnlyTransaction,
} = await import("./evalQueryTypes.js");

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const INT8: ColumnType = { typname: "int8", category: "N", elementCategory: null };
const INT4: ColumnType = { typname: "int4", category: "N", elementCategory: null };
const NUMERIC: ColumnType = { typname: "numeric", category: "N", elementCategory: null };
const TIMESTAMPTZ: ColumnType = { typname: "timestamptz", category: "D", elementCategory: null };
const BOOL: ColumnType = { typname: "bool", category: "B", elementCategory: null };
const JSON_T: ColumnType = { typname: "json", category: "U", elementCategory: null };
const GEOMETRY: ColumnType = { typname: "geometry", category: "U", elementCategory: null };
const INT8_ARRAY: ColumnType = { typname: "_int8", category: "A", elementCategory: "N" };

const declared = (kinds: Kind[], elements: Kind[] = []): Declared => ({
  kinds: new Set(kinds),
  elements: new Set(elements),
});

// -- the verdict, against the bug it exists to catch ---------------------------

test("THE BUG IT EXISTS FOR (paid-for #30): an int8 declared `number` is a LIE on pg's default driver", () => {
  // SessionVerdict.id and the nine fields in types/index.ts, for the life of
  // the project. This is the census failing on the world as it was.
  const delivered = deliveredShape(INT8, pgDefaultInt8);
  assert.deepEqual(delivered, { kind: "string" });
  assert.equal(judge(delivered, declared(["number"]), false), "lie");
});

test("...and the same declaration passes on the driver as db/pgTypes.ts configures it", () => {
  const delivered = deliveredShape(INT8, configuredParser(20));
  assert.deepEqual(delivered, { kind: "number" });
  assert.equal(judge(delivered, declared(["number"]), false), "ok");
});

test("THE OTHER DIRECTION: an int8 declared `string` is a lie once the driver delivers numbers", () => {
  // findHoles' BucketRow.segment_id: the lie that made `.padStart` a crash.
  assert.equal(judge(deliveredShape(INT8, configuredParser(20)), declared(["string"]), false), "lie");
});

test("numeric is still text, so a numeric declared `number` is a lie and `unknown` is honest", () => {
  const delivered = deliveredShape(NUMERIC, configuredParser(1700));
  assert.deepEqual(delivered, { kind: "string" });
  assert.equal(judge(delivered, declared(["number", "null"]), false), "lie");
  assert.equal(judge(delivered, declared(["unknown"]), false), "ok");
});

test("a timestamptz is a Date, so declaring it `string` is a lie", () => {
  // SessionSample.recordedAt: Date.parse() of a Date drops its milliseconds.
  const delivered = deliveredShape(TIMESTAMPTZ, configuredParser(1184));
  assert.deepEqual(delivered, { kind: "Date" });
  assert.equal(judge(delivered, declared(["string"]), false), "lie");
  assert.equal(judge(delivered, declared(["Date", "null"]), false), "ok");
});

test("an int4 declared `string` is a lie on either driver", () => {
  // evalLinkerFold's `{ n: string }` over count(...)::int.
  assert.equal(judge(deliveredShape(INT4, configuredParser(23)), declared(["string"]), false), "lie");
});

test("int8 arrays are judged by their elements", () => {
  const delivered = deliveredShape(INT8_ARRAY, configuredParser(1016));
  assert.deepEqual(delivered, { kind: "array", element: "number" });
  assert.equal(judge(delivered, declared(["array"], ["number"]), false), "ok");
  assert.equal(judge(delivered, declared(["array"], ["string"]), false), "lie");
  assert.equal(judge(delivered, declared(["number"]), false), "lie");
});

test("json is parsed into any shape, so there is nothing to judge", () => {
  assert.deepEqual(deliveredShape(JSON_T, configuredParser(114)), { kind: "unknown" });
  assert.equal(judge({ kind: "unknown" }, declared(["object"]), false), "ok");
});

test("json is `unknown` whatever one sample makes of it, not only when the sample fails to parse", () => {
  // json's real category is U, whose sample does not parse, so a cold review's
  // mutant removing the json rule changed nothing there. A sample that DOES
  // parse is the case the rule is for: one document's shape is not the type's.
  assert.deepEqual(deliveredShape({ typname: "json", category: "N", elementCategory: null }, JSON.parse), {
    kind: "unknown",
  });
});

test("a parser that rejects the sample leaves the shape unknown, never assumed to be text", () => {
  const refuses = (): never => {
    throw new Error("not a value of this type");
  };
  assert.deepEqual(deliveredShape(INT4, refuses), { kind: "unknown" });
});

test("a type with no parser, PostGIS geometry for one, arrives as text", () => {
  assert.deepEqual(deliveredShape(GEOMETRY, undefined), { kind: "string" });
});

test("booleans arrive as booleans, and a declared boolean admits them", () => {
  assert.deepEqual(deliveredShape(BOOL, configuredParser(16)), { kind: "boolean" });
  assert.equal(judge({ kind: "boolean" }, declared(["boolean"]), false), "ok");
});

test("rows typed `any` are untyped, never ok: the census says it could not check them", () => {
  assert.equal(judge({ kind: "string" }, undefined, true), "untyped");
  assert.equal(judge({ kind: "string" }, declared(["any"]), false), "untyped");
});

test("a returned column the row type does not declare is reported, not passed", () => {
  assert.equal(judge({ kind: "number" }, undefined, false), "undeclared");
});

test("kindOfValue tells the runtime kinds apart", () => {
  assert.equal(kindOfValue(null), "null");
  assert.equal(kindOfValue(new Date(0)), "Date");
  assert.equal(kindOfValue([1]), "array");
  assert.equal(kindOfValue(1n), "bigint");
  assert.equal(kindOfValue({}), "object");
});

test("showDeclared prints arrays the way the code spells them", () => {
  assert.equal(showDeclared(declared(["array", "null"], ["number"])), "number[] | null");
  assert.equal(showDeclared(declared(["array"], ["number", "null"])), "(number | null)[]");
});

// -- finding the queries ---------------------------------------------------------

// A real program over virtual files placed inside src/, so `pg` resolves to the
// real @types/pg exactly as it does for the project. The line numbers asserted
// below are lines of FIXTURE. Its second half is a cold review's catalogue of
// ways to reach a query that the first version of the census missed in silence.
const FIXTURE = `import type { Pool, PoolClient, QueryResultRow } from "pg";
declare const pool: Pool;
declare const client: PoolClient;
declare function runtimeTail(): string;
declare const sqlVar: string;
declare const flag: boolean;
declare const cursor: { submit(connection: unknown): void };
const LIMIT = 25;
const SQL = "select 2 as b";
type Plain = { query: (text: string) => Promise<{ rows: unknown[] }> };
declare const plain: Plain;
async function run(text: string) {
  return (await pool.query(text)).rows;
}
export async function cases() {
  await pool.query<{ id: number; name: string | null; ok: boolean }>("select id, name, ok from t");
  const untyped = await pool.query("select id from t");
  await pool.query(\`select id from t limit \${LIMIT}\`);
  const tail = await pool.query(\`select id from t limit \${LIMIT} \${runtimeTail()}\`);
  await pool.query(SQL);
  const { rows } = (await client.query("select 1 as a")) as { rows: { a: string; at: Date; ids: number[] }[] };
  const fake: { query: (text: string) => Promise<{ rows: unknown[] }> } = { query: async () => ({ rows: [] }) };
  await fake.query("select 3 as c");
  const notADatabase = { query: (n: number) => n };
  notADatabase.query(5);
  const cast = (await plain.query("select 4 as d")) as { rows: { d: string }[] };
  await plain.query(\`select \${LIMIT} as e\`);
  const plainRuntime = await plain.query(\`select e from t \${runtimeTail()}\`);
  const plainVariable = await plain.query(sqlVar);
  await pool["query"]("select 5 as f");
  const bound = pool.query.bind(pool);
  await bound("select 6 as g");
  await pool.query({ text: "select 7 as h", values: [] });
  await pool.query(flag ? "select 8 as i" : "select 9 as j");
  const indexed = await pool.query<Record<string, number>>("select 10 as k");
  pool.query(cursor);
  await pool.query(sqlVar);
  return [untyped, tail, rows, cast, plainRuntime, plainVariable, indexed, run];
}
export async function generic<T extends QueryResultRow>() {
  return (await pool.query<T>("select 11 as m")).rows;
}
declare const methodClient: { query(text: string): Promise<{ rows: unknown[] }> };
export const viaMethod = methodClient.query("select 12 as n");
export const viaElement = plain["query"]("select 13 as o");
import { Query, type QueryResult } from "pg";
declare function use(...values: unknown[]): void;
export async function hidden() {
  const { rows: holes } = await pool.query("select 14 as id");
  const crash = holes[0].id.padStart(6);
  const viaPromise = await (pool.query("select 15 as p") as Promise<QueryResult<{ p: number }>>);
  const onRows = (await pool.query("select 16 as q")).rows as { q: string }[];
  pool.query("select 17 as r", (err: Error, r: QueryResult<{ r: string }>) => use(err, r.rows));
  pool.query("select 18 as s", (err, r) => use(err, r.rows));
  pool.query(sqlVar, (err, r) => use(err, r.rows));
  client.query(new Query<{ t: number }>("select 19 as t"));
  return [crash, viaPromise, onRows];
}
class DescribeStatement { submit(): void {} }
export const impostor = () => client.query(new DescribeStatement());
`;
const FIXTURE_TEST = `import type { Pool } from "pg";
declare const pool: Pool;
export const skipped = pool.query("select 'a test fake, never described' as x");
`;

function programOf(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const slash = (p: string) => p.split(path.sep).join("/");
  const virtual = new Map(Object.entries(files).map(([name, text]) => [slash(path.join(backendDir, "src", name)), text]));
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => virtual.has(slash(f)) || fileExists.call(host, f);
  host.readFile = (f) => virtual.get(slash(f)) ?? readFile.call(host, f);
  host.getSourceFile = (f, language, ...rest) => {
    const text = virtual.get(slash(f));
    return text === undefined ? getSourceFile.call(host, f, language, ...rest) : ts.createSourceFile(f, text, language);
  };
  return ts.createProgram([...virtual.keys()], options, host);
}

const program = programOf({ "__census_fixture__.ts": FIXTURE, "__census_fixture__.test.ts": FIXTURE_TEST });
const sites = findQuerySites(program, backendDir);
const at = (line: number): QuerySite => {
  const site = sites.find((s) => s.line === line);
  assert.ok(site, `no site found on fixture line ${line}`);
  return site;
};
const props = (site: QuerySite) =>
  site.declared.kind === "typed"
    ? Object.fromEntries([...site.declared.props].map(([k, v]) => [k, showDeclared(v)]))
    : site.declared.kind;

test("the fixture is valid TypeScript, so every site below is one the compiler accepts", () => {
  assert.deepEqual(
    ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    [],
  );
});

test("finds every database call however it is reached, and nothing else; test files skipped", () => {
  assert.deepEqual(
    sites.map((s) => [s.line, s.via]),
    [
      [13, "pg"], // inside a wrapper
      [16, "pg"], [17, "pg"], [18, "pg"], [19, "pg"], [20, "pg"], [21, "pg"],
      [23, "structural"], [26, "structural"], [27, "structural"], [28, "structural"], [29, "structural"],
      [30, "pg"], // pool["query"]
      [32, "pg"], // a copy made with bind
      [33, "pg"], // a config object
      [34, "pg"], // a choice between constants
      [35, "pg"], // an index signature
      [36, "pg"], // a Submittable
      [37, "pg"], // runtime text, result discarded
      [41, "pg"], // a type parameter for a row
      [44, "structural"], // a method named query, declared outside pg
      [45, "structural"], // plain["query"]
      [49, "pg"], [51, "pg"], [52, "pg"], // untyped, a cast on the promise, a cast on .rows
      [53, "pg"], [54, "pg"], [55, "pg"], // callbacks: typed, untyped, with a runtime statement
      [56, "pg"], // a pg.Query
      [60, "pg"], // a Submittable that only shares the census's class name
    ],
  );
  assert.ok(sites.every((s) => s.file === "src/__census_fixture__.ts"), "the .test.ts fixture was described");
});

test("NOT a database call: a `.query(5)` on something else", () => {
  assert.equal(sites.some((s) => s.line === 25), false);
});

test("A SUBMITTABLE IS A QUERY THE CENSUS CANNOT READ, named and counted as read, never dropped", () => {
  // A cold review's probe: `client.query(new pg.Query("select id from
  // segments"))` produced no site and no line. pg hands a Submittable the
  // connection, so its statement is not readable here, and its rows reach the
  // code through the object itself, wherever that is read. So it fails.
  assert.deepEqual(at(56).statements, []);
  assert.match(at(56).unresolved!, /^a Submittable \(Query\)/);
  assert.equal(at(56).resultUsed, true);
  assert.match(at(36).unresolved!, /^a Submittable \(\{ submit/);
  assert.equal(at(36).resultUsed, true, "even when the call stands alone");
  // Only the census's own class, from its own file, is exempt: not its name.
  assert.match(at(60).unresolved!, /^a Submittable \(DescribeStatement\)/);
  assert.equal(at(60).resultUsed, true);
  const census = judgeCensus([at(56)], new Map(), types);
  assert.deepEqual(census.unchecked, [at(56)]);
  assert.equal(census.pass, false);
});

test("THE CALLS THE FIRST VERSION MISSED IN SILENCE are found: element access and a bound copy", () => {
  // Decided by the declaration the call resolves to, not by how it is spelled.
  assert.deepEqual(at(30).statements, ["select 5 as f"]);
  assert.deepEqual(at(32).statements, ["select 6 as g"]);
});

test("the statement is read as it is sent: literal, constant substitution, constant identifier", () => {
  assert.deepEqual(at(16).statements, ["select id, name, ok from t"]);
  assert.deepEqual(at(18).statements, ["select id from t limit 25"]);
  assert.deepEqual(at(20).statements, ["select 2 as b"]);
});

test("a template built only from constants reads as one statement, through a plain client too", () => {
  // TypeScript folds it into a single string literal type in every context, not
  // only for pg's generic overload: this client takes a plain `string`.
  assert.deepEqual(at(27).statements, ["select 25 as e"]);
});

test("a config object's statement is read from its `text`", () => {
  assert.deepEqual(at(33).statements, ["select 7 as h"]);
});

test("a choice between constants describes EVERY branch, because each is sent sometime", () => {
  assert.deepEqual([...at(34).statements].sort(), ["select 8 as i", "select 9 as j"]);
});

test("a statement built at runtime is reported as such, naming the part that is", () => {
  // The constant before it is not the culprit, and is not named.
  assert.deepEqual(at(19).statements, []);
  assert.equal(at(19).unresolved, "${runtimeTail()}");
  assert.equal(at(29).unresolved, "sqlVar");
});

test("A PLAIN CLIENT'S RUNTIME STATEMENT is still a database call, not dropped from the census", () => {
  // A cold review's mutant that recognised a plain client only by literal text
  // survived: no fixture had a runtime-built statement through one.
  assert.equal(at(28).via, "structural");
  assert.equal(at(28).unresolved, "${runtimeTail()}");
});

test("a WRAPPER's statement is a parameter, and the report says so outright", () => {
  assert.equal(at(13).unresolved, "text, a parameter of run(): what its callers pass is not checked");
});

test("a result is READ when it is assigned, returned or chained, and not when the call stands alone", () => {
  assert.equal(at(13).resultUsed, true); // returned, through .rows
  assert.equal(at(17).resultUsed, true); // assigned
  assert.equal(at(16).resultUsed, false);
  assert.equal(at(37).resultUsed, false);
});

test("the declared row type comes from the generic", () => {
  assert.deepEqual(props(at(16)), { id: "number", name: "string | null", ok: "boolean" });
});

test("rows with no generic are `any`, recorded as untyped rather than as an empty row", () => {
  assert.equal(at(17).declared.kind, "any");
});

test("rows typed `unknown` are recorded as honest: nothing can be read without narrowing", () => {
  assert.equal(at(23).declared.kind, "unknown");
});

test("the declared row type comes from a cast on the awaited result too", () => {
  assert.deepEqual(props(at(21)), { a: "string", at: "Date", ids: "number[]" });
});

test("THROUGH A PLAIN CLIENT, the cast is the ONLY declaration, and it is read", () => {
  // traceOutAndBack and verifyRebuild type their client as `{ query(text) }`
  // and cast the result. For pg's own `query` TypeScript infers the row type
  // from the cast anyway, so a pg-only fixture could not tell this code was
  // missing (a mutation run proved it); here nothing else declares the row.
  assert.deepEqual(props(at(26)), { d: "string" });
});

test("AN INDEX SIGNATURE declares every column: `Record<string, number>` is judged, not waved through", () => {
  // The first version read named properties only, so every column of this row
  // came out "undeclared" and nothing was ever judged.
  const row = at(35).declared;
  assert.equal(showDeclared(declaredColumn(row, "k").declared!), "number");
  assert.equal(judge({ kind: "string" }, declaredColumn(row, "k").declared, false), "lie");
});

test("A TYPE PARAMETER is judged by its constraint: pg's QueryResultRow says any column, so untyped", () => {
  const row = at(41).declared;
  assert.equal(row.kind, "typed");
  assert.equal(judge({ kind: "string" }, declaredColumn(row, "m").declared, false), "untyped");
});

// -- the verdict over a whole census ----------------------------------------------

const site = (over: Partial<QuerySite> = {}): QuerySite => ({
  file: "src/x.ts",
  line: 1,
  via: "pg",
  statements: ["select id from t"],
  resultUsed: true,
  declared: { kind: "typed", props: new Map([["id", declared(["number"])]]), index: null },
  ...over,
});
const types = new Map<number, ColumnType>([[20, INT8], [25, { typname: "text", category: "S", elementCategory: null }]]);
const idColumn: Description = { columns: [{ name: "id", oid: 20 }] };
const census = (s: QuerySite, descriptions: Description[], driver = configuredParser) =>
  judgeCensus([s], new Map([[s, descriptions]]), types, driver);

test("CENSUS: a lie fails it, and the same row passes on the configured driver", () => {
  const s = site();
  assert.equal(census(s, [idColumn], (oid) => (oid === 20 ? pgDefaultInt8 : configuredParser(oid))).pass, false);
  assert.equal(census(s, [idColumn]).pass, true);
});

test("CENSUS: a statement the database would not describe fails it", () => {
  // A cold review's mutant that dropped this from the exit code survived: the
  // rule lived in main, where no test could reach it.
  const result = census(site(), [{ error: 'column "id" does not exist' }]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.undescribed.map((u) => u.error), ['column "id" does not exist']);
});

test("CENSUS: a runtime statement whose result is READ fails it; one whose result is discarded does not", () => {
  const read = site({ statements: [], unresolved: "text, a parameter of run()", resultUsed: true });
  const discarded = site({ statements: [], unresolved: "${tuples.join(\", \")}", resultUsed: false });
  const result = judgeCensus([read, discarded], new Map(), types);
  assert.deepEqual(result.unchecked, [read]);
  assert.deepEqual(result.unread, [discarded]);
  assert.equal(result.pass, false);
  assert.equal(judgeCensus([discarded], new Map(), types).pass, true);
});

test("CENSUS: `any` rows that are READ fail it; the same rows with the result discarded do not", () => {
  // A cold review's first finding: rows typed `any` passed, so the census
  // passed code it had not checked at all.
  const read = census(site({ declared: { kind: "any" } }), [idColumn]);
  assert.deepEqual(read.findings.map((f) => f.verdict), ["untyped"]);
  assert.deepEqual(read.untypedRead.map((f) => f.column), ["id"]);
  assert.equal(read.pass, false);
  const discarded = census(site({ declared: { kind: "any" }, resultUsed: false }), [idColumn]);
  assert.deepEqual(discarded.untypedRead, []);
  assert.equal(discarded.pass, true);
});

test("THE CRASH IT USED TO PASS: findHoles' `.padStart` on an int8, with the row type taken away", () => {
  // Fixture line 49: `holes[0].id.padStart(6)` on untyped rows compiles, and
  // throws on the configured driver. The census passed it until untyped rows
  // that are read failed it.
  assert.equal(at(49).declared.kind, "any");
  assert.equal(at(49).resultUsed, true);
  const result = census(at(49), [idColumn]);
  assert.deepEqual(result.untypedRead.map((f) => [f.site.line, f.column]), [[49, "id"]]);
  assert.equal(result.pass, false);
});

test("a statement returning no columns has nothing untyped to read, whatever reads its rowCount", () => {
  // routes/sessions.ts DELETE: `const { rowCount } = await pool.query("delete ...")`.
  const result = census(site({ declared: { kind: "any" } }), [{ columns: [] }]);
  assert.deepEqual(result.untypedRead, []);
  assert.equal(result.pass, true);
});

test("a cast on the PROMISE declares the row type, read through to what it resolves to", () => {
  assert.deepEqual(props(at(51)), { p: "number" });
});

test("a cast on `.rows` is not read as a declaration: untyped, so it fails rather than passing unread", () => {
  // Reading every place rows can be typed after the call is a chase with no
  // end (rows handed to a typed function, a typed `.then`). The census reads
  // the generic, a cast on the result, and a callback's parameter; anything
  // else is `any`, and `any` that is read fails, so it cannot pass by accident.
  assert.equal(at(52).declared.kind, "any");
  assert.equal(at(52).resultUsed, true);
});

test("CALLBACK STYLE reads the result: typed from the callback's parameter, untyped when it has none", () => {
  // A cold review's probe: the callback's rows were never seen, and a runtime
  // statement with a callback was filed as "result not read".
  assert.equal(at(53).resultUsed, true);
  assert.deepEqual(props(at(53)), { r: "string" });
  assert.equal(at(54).resultUsed, true);
  assert.equal(at(54).declared.kind, "any");
  assert.equal(at(55).resultUsed, true, "a runtime statement whose callback reads the rows");
  assert.deepEqual(judgeCensus([at(55)], new Map(), types).unchecked, [at(55)]);
});

test("AN UNQUOTED camelCase ALIAS fails: Postgres folds it to lower case, so the declared name is always undefined", () => {
  // `select segment_id as segmentId` returns a column named "segmentid".
  const row: RowType = { kind: "typed", props: new Map([["segmentId", declared(["number"])]]), index: null };
  const result = census(site({ declared: row }), [{ columns: [{ name: "segmentid", oid: 20 }] }]);
  assert.deepEqual(result.caseFolded.map((c) => c.name), ["segmentId"]);
  assert.deepEqual(result.neverReturned, []);
  assert.equal(result.pass, false);
});

test("a declared column that is simply absent is listed, and does not fail it", () => {
  // The shared-interface case: SessionSample declared, a query filling part of it.
  const row: RowType = { kind: "typed", props: new Map([["id", declared(["number"])], ["sessionId", declared(["number"])]]), index: null };
  const result = census(site({ declared: row }), [idColumn]);
  assert.deepEqual(result.neverReturned.map((n) => n.name), ["sessionId"]);
  assert.deepEqual(result.caseFolded, []);
  assert.equal(result.pass, true);
});

test("CENSUS: no sites at all fails it: a census that found nothing has checked nothing", () => {
  assert.equal(judgeCensus([], new Map(), types).pass, false);
});

test("CENSUS: a column whose type the database did not describe stops it, rather than being skipped", () => {
  // runCensus asks pg_type for every type it was described, so this cannot
  // happen against the real server; if it ever does, a column is not dropped.
  assert.throws(() => census(site(), [{ columns: [{ name: "id", oid: 99999 }] }]), /src\/x\.ts:1: no pg_type row for oid 99999/);
});

test("CENSUS: rows typed `unknown` pass every column honestly", () => {
  const result = census(site({ declared: { kind: "unknown" } }), [idColumn]);
  assert.deepEqual(result.findings.map((f) => f.verdict), ["ok"]);
});

test("CENSUS: every branch of a choice is judged, and a declared column never returned is listed", () => {
  const row: RowType = { kind: "typed", props: new Map([["id", declared(["string"])], ["gone", declared(["number"])]]), index: null };
  const s = site({ statements: ["select id from a", "select id from b"], declared: row });
  const result = census(s, [idColumn, idColumn]);
  assert.deepEqual(result.findings.map((f) => [f.statement, f.verdict]), [[0, "lie"], [1, "lie"]]);
  assert.deepEqual(result.neverReturned.map((n) => n.name), ["gone"]);
});

test("CENSUS: a site whose statements were not all described fails it, rather than being skipped", () => {
  const s = site({ statements: ["select id from a", "select id from b"] });
  assert.equal(census(s, [idColumn]).pass, false);
});

// -- describing without executing ----------------------------------------------

/** A connection that records every protocol message it is asked to send. */
const recording = () => {
  const sent: { message: string; args: unknown[] }[] = [];
  const connection = new Proxy(
    {},
    { get: (_target, message) => (...args: unknown[]) => void sent.push({ message: String(message), args }) },
  ) as pg.Connection;
  return { connection, sent };
};

test("THE SAFETY PROPERTY: a statement is parsed and described, never bound or executed", () => {
  // The whole case for pointing this at the live database. An INSERT ...
  // RETURNING must be described without being run.
  const { connection, sent } = recording();
  new DescribeStatement("insert into sessions default values returning id").submit(connection);
  assert.deepEqual(
    sent.map((s) => s.message),
    ["parse", "describe", "sync"],
  );
  assert.deepEqual(sent[0]!.args[0], { name: "", text: "insert into sessions default values returning id", types: [] });
  assert.deepEqual(sent[1]!.args[0], { type: "S", name: "" });
});

test("THE SECOND GUARD: the work runs inside BEGIN READ ONLY and is always rolled back", async () => {
  // A cold review's mutant that opened a plain BEGIN survived: the guard lived
  // in main, where no test could reach it.
  const commands: string[] = [];
  const client = { query: async (text: string) => void commands.push(text) };
  assert.equal(await withReadOnlyTransaction(client, async () => (commands.push("work"), 7)), 7);
  assert.deepEqual(commands, ["begin read only", "work", "rollback"]);

  commands.length = 0;
  await assert.rejects(withReadOnlyTransaction(client, async () => Promise.reject(new Error("boom"))), /boom/);
  assert.deepEqual(commands, ["begin read only", "rollback"]);
});

test("the columns come from the row description, and resolve when the server is ready", { timeout: 2000 }, async () => {
  const statement = new DescribeStatement("select 1");
  statement.handleRowDescription({ fields: [{ name: "id", dataTypeID: 20 }, { name: "at", dataTypeID: 1184 }] });
  statement.handleReadyForQuery();
  assert.deepEqual(await statement.result, { columns: [{ name: "id", oid: 20 }, { name: "at", oid: 1184 }] });
});

test("a statement with no result columns describes as none", { timeout: 2000 }, async () => {
  const statement = new DescribeStatement("begin");
  statement.handleReadyForQuery();
  assert.deepEqual(await statement.result, { columns: [] });
});

// The timeouts are the test: a promise that never settles would otherwise hang
// the suite instead of failing it.
test("an error resolves at once, because pg never routes the ReadyForQuery after it here", { timeout: 2000 }, async () => {
  const statement = new DescribeStatement("select nope");
  statement.handleError(new Error('column "nope" does not exist'));
  assert.deepEqual(await statement.result, { error: 'column "nope" does not exist' });
});

test("ONE BAD STATEMENT STAYS ONE: each describe is fenced by a savepoint, rolled back on error", { timeout: 2000 }, async () => {
  // Any error aborts the transaction it is in, and every describe after it then
  // fails with "current transaction is aborted" -- shown against the live
  // database on 2026-10-05 with a control that omitted the savepoints. This
  // fake answers the protocol the way the server does for each statement and
  // records the commands, so it pins the fencing rather than the server.
  const commands: string[] = [];
  const fake = {
    query: (arg: unknown) => {
      if (typeof arg === "string") {
        commands.push(arg);
        return Promise.resolve({ rows: [] });
      }
      const statement = arg as InstanceType<typeof DescribeStatement>;
      queueMicrotask(() => {
        if (statement.text.includes("no_such_column")) {
          statement.handleError(new Error('column "no_such_column" does not exist'));
        } else {
          statement.handleRowDescription({ fields: [{ name: "a", dataTypeID: 23 }] });
          statement.handleReadyForQuery();
        }
      });
      return statement;
    },
  } as unknown as pg.PoolClient;

  const results = await describeAll(fake, ["select 1 as a", "select no_such_column", "select 2 as a"]);
  assert.deepEqual(results.map((r) => ("error" in r ? "error" : "columns")), ["columns", "error", "columns"]);
  assert.deepEqual(commands, [
    "savepoint describe", "release savepoint describe",
    "savepoint describe", "rollback to savepoint describe",
    "savepoint describe", "release savepoint describe",
  ]);
});

test("anything that only follows an Execute is refused loudly", () => {
  const statement = new DescribeStatement("select 1");
  assert.throws(() => statement.handleDataRow(), /something was executed/);
  assert.throws(() => statement.handleCommandComplete(), /something was executed/);
  assert.throws(() => statement.handleEmptyQuery(), /something was executed/);
  assert.throws(() => statement.handlePortalSuspended(), /something was executed/);
  assert.throws(() => statement.handleCopyInResponse(), /something was executed/);
});

// -- the command: what reaches the database, and whether failing fails ----------

const PG_TYPE: Record<number, ColumnType> = {
  16: BOOL,
  20: INT8,
  25: { typname: "text", category: "S", elementCategory: null },
};

/**
 * The live database as runCensus meets it, answering by statement text the way
 * the server does and recording everything it is sent: text as it is, a
 * DescribeStatement as `DESCRIBE <text>`, anything else as EXECUTED.
 */
const fakeDatabase = (columnsOf: Record<string, Column[]>) => {
  const sent: string[] = [];
  const client = {
    query: (arg: unknown, values?: unknown[]) => {
      if (typeof arg === "string") {
        if (!/from pg_type/.test(arg)) {
          sent.push(arg);
          return Promise.resolve({ rows: [] });
        }
        const oids = values?.[0] as number[];
        sent.push(`PG_TYPE ${[...oids].sort((a, b) => a - b).join(",")}`);
        return Promise.resolve({ rows: oids.map((oid) => ({ oid, ...PG_TYPE[oid]! })) });
      }
      if (!(arg instanceof DescribeStatement)) {
        sent.push(`EXECUTED ${JSON.stringify(arg)}`);
        return Promise.resolve({ rows: [] });
      }
      sent.push(`DESCRIBE ${arg.text}`);
      queueMicrotask(() => {
        const columns = columnsOf[arg.text];
        if (columns === undefined) return arg.handleError(new Error(`relation for "${arg.text}" does not exist`));
        arg.handleRowDescription({ fields: columns.map((c) => ({ name: c.name, dataTypeID: c.oid })) });
        arg.handleReadyForQuery();
      });
      return arg;
    },
  } as unknown as pg.PoolClient;
  return { client, sent };
};

// Two sites whose columns differ in name and type, the first sending either of
// two statements, plus a runtime statement nothing reads: descriptions handed
// to the wrong site would judge the wrong columns.
const COLUMNS: Record<string, Column[]> = {
  "select a from t": [{ name: "a", oid: 20 }],
  "select b from t": [{ name: "b", oid: 25 }],
  "select c from t": [{ name: "c", oid: 16 }],
};
const typedRow = (entries: [string, Kind][]): RowType => ({
  kind: "typed",
  props: new Map(entries.map(([name, kind]) => [name, declared([kind])])),
  index: null,
});
const commandSites = (aIs: Kind = "number"): QuerySite[] => [
  site({ line: 10, statements: ["select a from t", "select b from t"], declared: typedRow([["a", aIs], ["b", "string"]]) }),
  site({ line: 20, statements: ["select c from t"], declared: typedRow([["c", "boolean"]]) }),
  site({ line: 30, statements: [], unresolved: "${tuples.join(\", \")}", resultUsed: false }),
];

/** Runs the command's body; gives back what it printed and the exit code it set, then restores the real one. */
async function command(client: pg.PoolClient, sites: QuerySite[], outside: string[] = []) {
  const printed: string[] = [];
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    const result = await runCensus(client, sites, outside, (line) => printed.push(line));
    return { result, printed, exitCode: process.exitCode };
  } finally {
    process.exitCode = before;
  }
}

test("WHAT THE COMMAND SENDS THE LIVE DATABASE: describes inside BEGIN READ ONLY, then rollback, nothing else", { timeout: 2000 }, async () => {
  // A cold review's two edits, executing each statement instead of describing
  // it and dropping READ ONLY, would together have run rebuildModel's three
  // DELETEs against the production model in autocommit, with every test green:
  // the safety lived in main(), where no test reached. This pins all of it.
  const { client, sent } = fakeDatabase(COLUMNS);
  await command(client, commandSites());
  assert.deepEqual(sent, [
    "begin read only",
    "savepoint describe", "DESCRIBE select a from t", "release savepoint describe",
    "savepoint describe", "DESCRIBE select b from t", "release savepoint describe",
    "savepoint describe", "DESCRIBE select c from t", "release savepoint describe",
    "PG_TYPE 16,20,25",
    "rollback",
  ]);
});

test("EACH SITE IS JUDGED AGAINST ITS OWN STATEMENTS' COLUMNS, a two-statement site included", { timeout: 2000 }, async () => {
  const { result } = await command(fakeDatabase(COLUMNS).client, commandSites());
  assert.deepEqual(
    result.findings.map((f) => [f.site.line, f.statement, f.column, f.typname, f.verdict]),
    [
      [10, 0, "a", "int8", "ok"],
      [10, 1, "b", "text", "ok"],
      [20, 0, "c", "bool", "ok"],
    ],
  );
  assert.deepEqual(result.unread.map((s) => s.line), [30]);
  assert.equal(result.pass, true);
});

test("A FAILING CENSUS FAILS THE PROCESS, and a passing one leaves the exit code alone", { timeout: 2000 }, async () => {
  // "Can genuinely fail" rests on the exit code. A cold review deleted the line
  // that set it, in main(), and every test still passed.
  const passing = await command(fakeDatabase(COLUMNS).client, commandSites());
  assert.equal(passing.exitCode, undefined);
  assert.equal(passing.printed.at(-1), "0 lies, 0 undescribed, 0 unchecked, 0 untyped and read, 0 folded. PASS");

  const lying = await command(fakeDatabase(COLUMNS).client, commandSites("string"));
  assert.equal(lying.exitCode, 1);
  assert.equal(lying.printed.at(-1), "1 lies, 0 undescribed, 0 unchecked, 0 untyped and read, 0 folded. FAIL");
  assert.ok(
    lying.printed.some((line) => /^ {2}src\/x\.ts:10 \[1\] +a +int8 +-> number +declared string$/.test(line)),
    lying.printed.join("\n"),
  );
});

test("a statement the database refuses fails the process too, and the describes after it still run", { timeout: 2000 }, async () => {
  const { client, sent } = fakeDatabase({ "select c from t": COLUMNS["select c from t"]! });
  const { result, exitCode } = await command(client, commandSites());
  assert.deepEqual(result.undescribed.map((u) => u.site.line), [10, 10]);
  assert.ok(sent.includes("DESCRIBE select c from t"));
  assert.equal(exitCode, 1);
});

test("A FAILING REPORT NAMES EVERY SITE THAT FAILED IT, each under its own heading", { timeout: 2000 }, async () => {
  const failing = [
    site({ line: 10, statements: ["select a from t"], declared: typedRow([["a", "string"]]) }),
    site({ line: 40, statements: ["select c from t"], declared: { kind: "any" } }),
    site({ line: 50, statements: [], unresolved: "text, a parameter of run()" }),
    site({ line: 60, statements: ["select x as segmentId from t"], declared: typedRow([["segmentId", "number"]]) }),
    site({ line: 70, statements: ["select nope"] }),
  ];
  const db = fakeDatabase({ ...COLUMNS, "select x as segmentId from t": [{ name: "segmentid", oid: 20 }] });
  const { printed, exitCode } = await command(db.client, failing);
  const under = (heading: string): string => {
    const at = printed.findIndex((line) => line.startsWith(heading));
    assert.ok(at >= 0, `no ${heading} section in:\n${printed.join("\n")}`);
    return printed[at + 1]!;
  };
  assert.match(under("LIES"), /^ {2}src\/x\.ts:10 +a /);
  assert.match(under("COULD NOT BE DESCRIBED"), /^ {2}src\/x\.ts:70 /);
  assert.match(under("UNCHECKED"), /^ {2}src\/x\.ts:50 +text, a parameter of run\(\)$/);
  assert.match(under("UNTYPED AND READ"), /^ {2}src\/x\.ts:40 +c /);
  assert.match(under("FOLDED TO LOWER CASE"), /^ {2}src\/x\.ts:60 +segmentId$/);
  assert.equal(printed.at(-1), "1 lies, 1 undescribed, 1 unchecked, 1 untyped and read, 1 folded. FAIL");
  assert.equal(exitCode, 1);
});

test("the report names what the census cannot read, so nothing is skipped in silence", { timeout: 2000 }, async () => {
  const { printed } = await command(fakeDatabase(COLUMNS).client, commandSites(), ["../osm-pipeline/scripts/lib/linkPlan.d.mts"]);
  const outside = printed.findIndex((line) => line.startsWith("OUTSIDE THE CENSUS"));
  assert.ok(outside >= 0, printed.join("\n"));
  assert.equal(printed[outside + 1], "  ../osm-pipeline/scripts/lib/linkPlan.d.mts");
  assert.ok(printed.some((line) => line.startsWith("NOTHING TO CHECK")));
});

// -- the census over the real program --------------------------------------------

test("THE REAL PROGRAM: every directory is searched, under the config that also sees evalLinkerFold.ts", () => {
  // Every other test here runs on a fixture, so a cold review could point the
  // census at tsconfig.json (which drops evalLinkerFold.ts), or skip routes/ or
  // scripts/, and nothing failed. This loads what `npm run typecheck` loads.
  const real = loadProgram(backendDir);
  const found = findQuerySites(real, backendDir);
  const files = new Set(found.map((s) => s.file));
  for (const file of [
    "src/routes/segments.ts",
    "src/routes/sessions.ts",
    "src/services/usableSessions.ts",
    "src/scripts/findHoles.ts",
    "src/scripts/evalLinkerFold.ts",
  ]) {
    assert.ok(files.has(file), `no query found in ${file}`);
  }
  assert.ok(![...files].some((file) => file.endsWith(".test.ts")), "a test's fake was taken for a query");
  // The census's own describe is a Submittable, named, and delivers no rows.
  const own = found.filter((s) => s.unresolved?.startsWith("DescribeStatement"));
  assert.deepEqual(own.map((s) => [s.file, s.resultUsed]), [["src/scripts/evalQueryTypes.ts", false]]);
  // osm-pipeline's linkPlan.mjs runs on the backend's client and is read
  // through a declaration file: named, because its queries are not checked.
  assert.deepEqual(unreadModules(real, backendDir), ["../osm-pipeline/scripts/lib/linkPlan.d.mts"]);
});
