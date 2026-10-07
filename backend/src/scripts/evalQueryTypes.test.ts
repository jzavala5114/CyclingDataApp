import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import ts from "typescript";
import type { ColumnType, Declared, Kind } from "./evalQueryTypes.js";

// pg's own int8 parser, captured BEFORE the census module loads: it imports
// db/pool.ts, which replaces this parser for the whole process. The census has
// to be shown failing on the driver as it was, not only passing on the driver as
// it is, so both are held here, and the order is this file's decision.
const pgDefaultInt8 = pg.types.getTypeParser(pg.types.builtins.INT8, "text") as (text: string) => unknown;
const { DescribeStatement, configuredParser, deliveredShape, describeAll, findQuerySites, judge, kindOfValue, showDeclared } =
  await import("./evalQueryTypes.js");

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

test("a type with no parser, PostGIS geometry for one, arrives as text", () => {
  assert.deepEqual(deliveredShape(GEOMETRY, undefined), { kind: "string" });
});

test("booleans arrive as booleans", () => {
  assert.deepEqual(deliveredShape(BOOL, configuredParser(16)), { kind: "boolean" });
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
// real @types/pg exactly as it does for the project.
const FIXTURE = `import type { Pool, PoolClient } from "pg";
declare const pool: Pool;
declare const client: PoolClient;
declare function runtimeTail(): string;
const LIMIT = 25;
const SQL = "select 2 as b";
type Plain = { query: (text: string) => Promise<{ rows: unknown[] }> };
declare const plain: Plain;
export async function cases() {
  await pool.query<{ id: number; name: string | null }>("select id, name from t");
  await pool.query("select id from t");
  await pool.query(\`select id from t limit \${LIMIT}\`);
  await pool.query(\`select id from t \${runtimeTail()}\`);
  await pool.query(SQL);
  const { rows } = (await client.query("select 1 as a")) as { rows: { a: string; at: Date; ids: number[] }[] };
  const fake: { query: (text: string) => Promise<{ rows: unknown[] }> } = { query: async () => ({ rows: [] }) };
  await fake.query("select 3 as c");
  const notADatabase = { query: (n: number) => n };
  notADatabase.query(5);
  const cast = (await plain.query("select 4 as d")) as { rows: { d: string }[] };
  await plain.query(\`select \${LIMIT} as e\`);
  return [rows, cast];
}
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

const sites = findQuerySites(
  programOf({ "__census_fixture__.ts": FIXTURE, "__census_fixture__.test.ts": FIXTURE_TEST }),
  backendDir,
);
const props = (site: (typeof sites)[number]) =>
  Object.fromEntries(
    [...(site.declared instanceof Map ? site.declared : new Map<string, Declared>())].map(([k, v]) => [k, showDeclared(v)]),
  );

test("finds every database call and nothing else, test files skipped", () => {
  assert.deepEqual(
    sites.map((s) => [s.file, s.line, s.via]),
    [
      ["src/__census_fixture__.ts", 10, "pg"],
      ["src/__census_fixture__.ts", 11, "pg"],
      ["src/__census_fixture__.ts", 12, "pg"],
      ["src/__census_fixture__.ts", 13, "pg"],
      ["src/__census_fixture__.ts", 14, "pg"],
      ["src/__census_fixture__.ts", 15, "pg"],
      ["src/__census_fixture__.ts", 17, "structural"],
      ["src/__census_fixture__.ts", 20, "structural"],
      ["src/__census_fixture__.ts", 21, "structural"],
    ],
  );
});

test("the statement is read as it is sent: literal, constant substitution, constant identifier", () => {
  assert.equal(sites[0]!.sql, "select id, name from t");
  assert.equal(sites[2]!.sql, "select id from t limit 25");
  assert.equal(sites[4]!.sql, "select 2 as b");
});

test("a template built only from constants reads as one statement, through a plain client too", () => {
  // TypeScript folds it into a single string literal type in every context, not
  // only for pg's generic overload: this client takes a plain `string`.
  assert.equal(sites[8]!.sql, "select 25 as e");
});

test("a statement built at runtime is reported as such, never guessed at", () => {
  assert.equal(sites[3]!.sql, null);
  assert.equal(sites[3]!.unresolved, "${runtimeTail()}");
});

test("the declared row type comes from the generic", () => {
  assert.deepEqual(props(sites[0]!), { id: "number", name: "string | null" });
});

test("rows with no generic are `any`, recorded as untyped rather than as an empty row", () => {
  assert.equal(sites[1]!.declared, "any");
});

test("rows typed `unknown` are recorded as honest: nothing can be read without narrowing", () => {
  assert.equal(sites[6]!.declared, "unknown");
});

test("the declared row type comes from a cast on the awaited result too", () => {
  assert.deepEqual(props(sites[5]!), { a: "string", at: "Date", ids: "number[]" });
});

test("THROUGH A PLAIN CLIENT, the cast is the ONLY declaration, and it is read", () => {
  // traceOutAndBack and verifyRebuild type their client as `{ query(text) }`
  // and cast the result. For pg's own `query` TypeScript infers the row type
  // from the cast anyway, so a pg-only fixture could not tell this code was
  // missing (a mutation run proved it); here nothing else declares the row.
  assert.deepEqual(props(sites[7]!), { d: "string" });
});

test("THE BLIND SPOT THE FIRST VERSION HAD: a client typed as { query } is still a database call", () => {
  // verifyRebuild hands its query to a structurally typed client so a test can
  // pass a fake. Matching on pg's declaration alone never saw it at all.
  assert.equal(sites[6]!.via, "structural");
  assert.equal(sites[6]!.sql, "select 3 as c");
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
