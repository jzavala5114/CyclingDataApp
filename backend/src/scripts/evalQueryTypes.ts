import "dotenv/config";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import ts from "typescript";
import { pool } from "../db/pool.js";

// Asks the live database what every query in the backend returns, and checks
// that against the row type the code declares for it.
//
// The generic on `db.query<T>` is an assertion. node-postgres never sees it: it
// hands JS whatever its parser for each column's Postgres type produces. So for
// the life of the project `bigint` ids arrived as TEXT while nine interfaces
// said `number` (paid-for #30), and nothing could notice. The compiler checks
// code against the declared type, and the tests feed fixtures built from that
// same declared type. Only the database knows what a column is, so this asks it.
//
// It executes nothing. Each statement goes out as Parse + Describe + Sync, the
// messages a driver uses to learn a statement's result columns before binding
// it, so an INSERT ... RETURNING is described without being run. The session
// also sits inside BEGIN READ ONLY, so a statement that somehow did execute
// could not write. `DescribeStatement` is tested for exactly that.
//
// Read-only.
//
//   npm run eval:query-types
//
// Exits 1 when a declared type disagrees with what the driver delivers, or when
// a statement it found could not be described: a census that skipped a query
// has not shown that the query is fine.

/** What a declared TypeScript type, or a value the driver produced, is at runtime. */
export type Kind =
  | "number"
  | "string"
  | "boolean"
  | "bigint"
  | "Date"
  | "array"
  | "object"
  | "null"
  | "undefined"
  | "unknown"
  | "any";

/** A declared property type: its kinds, and for its array members, their elements' kinds. */
export interface Declared {
  kinds: Set<Kind>;
  elements: Set<Kind>;
}

export interface QuerySite {
  /** Relative to backend/, with forward slashes. */
  file: string;
  line: number;
  /** "pg" when the method is node-postgres' own; "structural" for a client typed as `{ query(...) }`. */
  via: "pg" | "structural";
  /** The statement exactly as it is sent, or null when part of it is only known at runtime. */
  sql: string | null;
  /** The expression that could not be resolved, when `sql` is null. */
  unresolved?: string;
  /**
   * The declared row type, by property. "any" when nothing is declared, so
   * nothing can be checked. "unknown" when the rows are `unknown`, which is
   * honest: no column can be read without the code narrowing it first.
   */
  declared: Map<string, Declared> | "any" | "unknown";
}

/** The project exactly as `npm run typecheck` sees it, tests and local tools included. */
export function loadProgram(backendDir: string): ts.Program {
  const configPath = path.join(backendDir, "tsconfig.check.json");
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, backendDir, undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  }
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/**
 * Every database call outside the tests, with the statement it sends and the
 * row type it declares: node-postgres' own `query`, and any client typed as
 * `{ query(text) }` (see queryCall). Tests are skipped because their `db` is a
 * fake: what they declare is checked against the fixture, not the database.
 */
export function findQuerySites(program: ts.Program, backendDir: string): QuerySite[] {
  const checker = program.getTypeChecker();
  const sites: QuerySite[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || /[\\/]node_modules[\\/]/.test(file.fileName)) continue;
    if (/\.test\.ts$/.test(file.fileName)) continue;
    const visit = (node: ts.Node): void => {
      const via = ts.isCallExpression(node) ? queryCall(node, checker) : null;
      if (via !== null) {
        const call = node as ts.CallExpression;
        const name = (call.expression as ts.PropertyAccessExpression).name;
        const text = sqlText(call.arguments[0], checker);
        sites.push({
          file: path.relative(backendDir, file.fileName).split(path.sep).join("/"),
          line: file.getLineAndCharacterOfPosition(name.getStart(file)).line + 1,
          via,
          sql: "sql" in text ? text.sql : null,
          ...("unresolved" in text ? { unresolved: text.unresolved } : {}),
          declared: declaredRow(call, checker),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return sites;
}

// A database call is node-postgres' own `query`, decided by where the method is
// declared rather than by its name. Or it is any other `.query()` whose first
// argument is SQL text: verifyRebuild types its client as `{ query(text) }`
// so a test can hand it a fake, and the first version of this census, matching
// on the declaration alone, never saw that query at all. A Submittable is not a
// statement, so it is never one.
function queryCall(call: ts.CallExpression, checker: ts.TypeChecker): QuerySite["via"] | null {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "query") return null;
  const first = call.arguments[0];
  if (first === undefined || checker.getTypeAtLocation(first).getProperty("submit") !== undefined) return null;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration !== undefined && /[\\/]@types[\\/]pg[\\/]/.test(declaration.getSourceFile().fileName)) return "pg";
  // Text only: a number has a literal type too, and `.query(5)` is not SQL.
  const text = ts.isTemplateExpression(first) || checker.getTypeAtLocation(first).isStringLiteral();
  return text ? "structural" : null;
}

// The statement as it is sent, read off its type. TypeScript gives a string
// literal, a constant holding one, and a template whose every substitution is a
// constant all a string literal TYPE, folded to the exact text (checked on 5.9:
// `select ${LIMIT}` with `const LIMIT = 25` types as "select 25", through any
// client). A first version also rebuilt templates span by span; a mutation run
// showed that code could never change an answer, because a span TypeScript
// cannot fold is a span it could not read either. Anything else is runtime-built
// and is reported as such, naming the substitution that makes it so.
function sqlText(arg: ts.Expression | undefined, checker: ts.TypeChecker): { sql: string } | { unresolved: string } {
  if (arg === undefined) return { unresolved: "(no arguments)" };
  const type = checker.getTypeAtLocation(arg);
  if (type.isStringLiteral()) return { sql: type.value };
  if (ts.isTemplateExpression(arg)) {
    const runtime = arg.templateSpans.find((span) => !isConstant(checker.getTypeAtLocation(span.expression)));
    if (runtime !== undefined) return { unresolved: `\${${runtime.expression.getText()}}` };
  }
  return { unresolved: arg.getText().slice(0, 80) };
}

const isConstant = (type: ts.Type): boolean => type.isStringLiteral() || type.isNumberLiteral();

// The row type comes from the generic (`db.query<Row>(...)`) or, in a few
// scripts, from a cast on the awaited result (`(await db.query(...)) as
// { rows: Row[] }`). Both end up as the element type of `rows`.
function declaredRow(call: ts.CallExpression, checker: ts.TypeChecker): QuerySite["declared"] {
  let outer: ts.Node = call.parent;
  if (ts.isAwaitExpression(outer)) outer = outer.parent;
  while (ts.isParenthesizedExpression(outer)) outer = outer.parent;
  const result =
    ts.isAsExpression(outer) || ts.isTypeAssertionExpression(outer)
      ? checker.getTypeFromTypeNode(outer.type)
      : checker.getAwaitedType(checker.getTypeAtLocation(call));
  const rows = result && checker.getPropertyOfType(result, "rows");
  if (!rows) return "any";
  const rowsType = checker.getTypeOfSymbolAtLocation(rows, call);
  const row = checker.isArrayType(rowsType) ? checker.getTypeArguments(rowsType as ts.TypeReference)[0] : undefined;
  if (!row || row.flags & ts.TypeFlags.Any) return "any";
  if (row.flags & ts.TypeFlags.Unknown) return "unknown";
  const declared = new Map<string, Declared>();
  for (const property of checker.getPropertiesOfType(row)) {
    declared.set(property.name, declaredOf(checker.getTypeOfSymbolAtLocation(property, call), checker));
  }
  return declared;
}

export function declaredOf(type: ts.Type, checker: ts.TypeChecker): Declared {
  const kinds = new Set<Kind>();
  const elements = new Set<Kind>();
  const add = (t: ts.Type, into: Set<Kind>, depth: number): void => {
    if (t.isUnion()) return t.types.forEach((member) => add(member, into, depth));
    const flags = t.flags;
    if (flags & ts.TypeFlags.Any) into.add("any");
    else if (flags & ts.TypeFlags.Unknown) into.add("unknown");
    else if (flags & ts.TypeFlags.NumberLike) into.add("number");
    else if (flags & ts.TypeFlags.StringLike) into.add("string");
    else if (flags & ts.TypeFlags.BooleanLike) into.add("boolean");
    else if (flags & ts.TypeFlags.BigIntLike) into.add("bigint");
    else if (flags & ts.TypeFlags.Null) into.add("null");
    else if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) into.add("undefined");
    else if (checker.isArrayType(t) || checker.isTupleType(t)) {
      into.add("array");
      if (depth === 0) {
        for (const element of checker.getTypeArguments(t as ts.TypeReference)) add(element, elements, depth + 1);
      }
    } else if (t.getSymbol()?.getName() === "Date") into.add("Date");
    else into.add("object");
  };
  add(type, kinds, 0);
  return { kinds, elements };
}

/** What node-postgres hands JS for one column. */
export interface Delivered {
  kind: Kind;
  element?: Kind;
}

/** A column's Postgres type, as pg_type describes it. */
export interface ColumnType {
  typname: string;
  /** pg_type.typcategory: N numeric, S string, B boolean, D date/time, A array, ... */
  category: string;
  /** The element type's category, for arrays. */
  elementCategory: string | null;
}

// A text value of each type category that its parser accepts.
const SAMPLE: Record<string, string> = {
  N: "1",
  B: "t",
  D: "2026-01-01 00:00:00+00",
  S: "x",
  T: "01:00:00",
  G: "(1,2)",
};

export function kindOfValue(value: unknown): Kind {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return "Date";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  return t === "number" || t === "string" || t === "boolean" || t === "bigint" ? t : "object";
}

/**
 * What the driver delivers for a column, found by running the column's own
 * parser on a sample rather than from a table of what parsers are meant to
 * return, so it reports the driver as this process has it configured.
 * `parse` is undefined when no parser is registered for the type: pg then
 * passes the text through untouched.
 */
export function deliveredShape(column: ColumnType, parse: ((text: string) => unknown) | undefined): Delivered {
  if (parse === undefined) return { kind: "string" };
  // Parsed into whatever shape the document has.
  if (column.typname === "json" || column.typname === "jsonb") return { kind: "unknown" };
  try {
    if (column.category === "A") {
      const sample = SAMPLE[column.elementCategory ?? ""] ?? "x";
      const value = parse(`{"${sample}"}`);
      return Array.isArray(value)
        ? { kind: "array", element: kindOfValue(value[0]) }
        : { kind: kindOfValue(value) };
    }
    return { kind: kindOfValue(parse(SAMPLE[column.category] ?? "x")) };
  } catch {
    return { kind: "unknown" };
  }
}

// pg-types answers every unregistered type with one shared pass-through
// function. Type 0 is never registered, so asking for it names that function.
const NO_TYPE = 0 as Parameters<typeof pg.types.getTypeParser>[0];

/** The parser this process's driver would use for a type, or undefined for pass-through text. */
export function configuredParser(oid: number): ((text: string) => unknown) | undefined {
  const parse = pg.types.getTypeParser(oid, "text") as (text: string) => unknown;
  return parse === pg.types.getTypeParser(NO_TYPE, "text") ? undefined : parse;
}

export type Verdict = "ok" | "lie" | "untyped" | "undeclared";

/**
 * Does the declared type admit what the driver delivers?
 *
 * `unknown` is an honest declaration (the code has to convert it) and passes.
 * `any` is not checked and says so. Nullability is not judged: a column
 * description does not say whether a value can be NULL.
 */
export function judge(delivered: Delivered, declared: Declared | undefined, rowIsAny: boolean): Verdict {
  if (rowIsAny) return "untyped";
  if (declared === undefined) return "undeclared";
  if (declared.kinds.has("any")) return "untyped";
  if (declared.kinds.has("unknown") || delivered.kind === "unknown") return "ok";
  if (!declared.kinds.has(delivered.kind)) return "lie";
  if (delivered.kind === "array" && delivered.element !== undefined && delivered.element !== "unknown") {
    const elements = declared.elements;
    const admits = elements.has("any") || elements.has("unknown") || elements.has(delivered.element);
    if (!admits) return "lie";
  }
  return "ok";
}

// null and undefined last, the way the code spells a union. TypeScript's own
// order is by internal type id, which prints `null | string`.
const inWritingOrder = (kinds: Set<Kind>): Kind[] => {
  const late = (k: Kind) => (k === "null" ? 1 : k === "undefined" ? 2 : 0);
  return [...kinds].sort((a, b) => late(a) - late(b));
};

export function showDeclared(declared: Declared): string {
  const elements = inWritingOrder(declared.elements).join(" | ");
  return inWritingOrder(declared.kinds)
    .map((kind) => (kind === "array" ? (declared.elements.size > 1 ? `(${elements})[]` : `${elements || "unknown"}[]`) : kind))
    .join(" | ");
}

export const showDelivered = (d: Delivered): string => (d.kind === "array" ? `${d.element ?? "unknown"}[]` : d.kind);

export interface Column {
  name: string;
  oid: number;
}

export type Description = { columns: Column[] } | { error: string };

/**
 * Learns a statement's result columns without running it: Parse, Describe,
 * Sync. Never Bind, never Execute. That is the whole case for pointing this at
 * the live database, so it is what the tests pin down.
 */
export class DescribeStatement implements pg.Submittable {
  readonly result: Promise<Description>;
  private resolve!: (description: Description) => void;
  private columns: Column[] = [];

  constructor(readonly text: string) {
    this.result = new Promise((resolve) => (this.resolve = resolve));
  }

  submit(connection: pg.Connection): void {
    // @types/pg still declares the old `more` argument; pg 8 ignores it.
    connection.parse({ name: "", text: this.text, types: [] }, false);
    connection.describe({ type: "S", name: "" }, false);
    connection.sync();
  }

  handleRowDescription(message: { fields: { name: string; dataTypeID: number }[] }): void {
    this.columns = message.fields.map((field) => ({ name: field.name, oid: field.dataTypeID }));
  }

  // A statement with no result columns gets NoData rather than a
  // RowDescription, and pg routes NoData nowhere. ReadyForQuery ends both.
  handleReadyForQuery(): void {
    this.resolve({ columns: this.columns });
  }

  // pg's client drops its active query before calling this, so the
  // ReadyForQuery that follows is never routed here. Resolve now.
  handleError(error: Error): void {
    this.resolve({ error: error.message });
  }

  // Each of these only follows an Execute.
  handleDataRow(): never {
    throw new Error("DescribeStatement received a row: something was executed");
  }
  handleCommandComplete(): never {
    throw new Error("DescribeStatement received CommandComplete: something was executed");
  }
  handleEmptyQuery(): never {
    throw new Error("DescribeStatement received EmptyQueryResponse: something was executed");
  }
  handlePortalSuspended(): never {
    throw new Error("DescribeStatement received PortalSuspended: something was executed");
  }
  handleCopyInResponse(): never {
    throw new Error("DescribeStatement received CopyInResponse: something was executed");
  }
}

/**
 * Describes each statement in turn, on a client that is already inside a
 * transaction (main opens it READ ONLY).
 *
 * Each describe gets its own savepoint. Any error inside a transaction aborts
 * it, so without one, a single statement that failed to describe would fail
 * every describe after it with "current transaction is aborted", and the report
 * would blame every later query for the first one's fault.
 */
export async function describeAll(client: pg.PoolClient, statements: string[]): Promise<Description[]> {
  const out: Description[] = [];
  for (const text of statements) {
    await client.query("savepoint describe");
    const statement = new DescribeStatement(text);
    client.query(statement);
    const description = await statement.result;
    await client.query("error" in description ? "rollback to savepoint describe" : "release savepoint describe");
    out.push(description);
  }
  return out;
}

const UNKNOWN: Declared = { kinds: new Set(["unknown"]), elements: new Set() };

interface TypeRow extends ColumnType {
  oid: number;
}

export interface Finding {
  site: QuerySite;
  column: string;
  typname: string;
  delivered: Delivered;
  declared: Declared | undefined;
  verdict: Verdict;
}

const where = (site: QuerySite): string => `${site.file}:${site.line}`;

async function main(): Promise<void> {
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sites = findQuerySites(loadProgram(backendDir), backendDir);

  const described = new Map<QuerySite, Description>();
  const types = new Map<number, TypeRow>();
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    const readable = sites.filter((site): site is QuerySite & { sql: string } => site.sql !== null);
    const descriptions = await describeAll(client, readable.map((site) => site.sql));
    readable.forEach((site, i) => described.set(site, descriptions[i]!));
    const oids = [...new Set([...described.values()].flatMap((d) => ("columns" in d ? d.columns : []).map((c) => c.oid)))];
    const { rows } = await client.query<TypeRow>(
      `select t.oid::int as oid, t.typname::text as typname, t.typcategory::text as category,
              e.typcategory::text as "elementCategory"
         from pg_type t
         left join pg_type e on e.oid = t.typelem and t.typcategory = 'A'
        where t.oid = any($1::int[])`,
      [oids],
    );
    for (const row of rows) types.set(row.oid, row);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }

  const findings: Finding[] = [];
  const failed: [QuerySite, string][] = [];
  const neverReturned: [QuerySite, string][] = [];
  let withColumns = 0;
  for (const [site, description] of described) {
    if ("error" in description) {
      failed.push([site, description.error]);
      continue;
    }
    if (description.columns.length > 0) withColumns += 1;
    for (const column of description.columns) {
      const type = types.get(column.oid);
      if (type === undefined) throw new Error(`${where(site)}: no pg_type row for oid ${column.oid}`);
      const delivered = deliveredShape(type, configuredParser(column.oid));
      const declared =
        site.declared === "unknown" ? UNKNOWN : site.declared === "any" ? undefined : site.declared.get(column.name);
      findings.push({
        site,
        column: column.name,
        typname: type.typname,
        delivered,
        declared,
        verdict: judge(delivered, declared, site.declared === "any"),
      });
    }
    if (site.declared instanceof Map) {
      const returned = new Set(description.columns.map((c) => c.name));
      for (const name of site.declared.keys()) if (!returned.has(name)) neverReturned.push([site, name]);
    }
  }

  const int8 = configuredParser(20);
  console.log(`query-type census: what the database returns, against what the code declares`);
  console.log(`driver in this process: bigint arrives as ${int8 ? kindOfValue(int8("1")) : "string"}\n`);
  const runtime = sites.filter((s) => s.sql === null);
  const structural = sites.filter((s) => s.via === "structural").length;
  console.log(
    `${sites.length} query call sites (${structural} through a client typed as \`{ query }\` rather than pg's): ` +
      `${withColumns} return columns, ${described.size - withColumns - failed.length} return none, ` +
      `${runtime.length} built at runtime, ${failed.length} could not be described`,
  );

  const section = (title: string, lines: string[]): void => {
    if (lines.length === 0) return;
    console.log(`\n${title} (${lines.length})`);
    for (const line of lines) console.log(`  ${line}`);
  };
  const row = (f: Finding): string =>
    `${where(f.site).padEnd(44)} ${f.column.padEnd(18)} ${f.typname.padEnd(10)} -> ${showDelivered(f.delivered).padEnd(9)}` +
    (f.declared ? ` declared ${showDeclared(f.declared)}` : "");

  section("LIES: the declared type does not admit what the driver delivers", findings.filter((f) => f.verdict === "lie").map(row));
  section("COULD NOT BE DESCRIBED", failed.map(([site, error]) => `${where(site).padEnd(44)} ${error}`));
  section(
    "UNTYPED: rows are `any`, so the code reading them cannot be checked here. Read each by hand",
    findings.filter((f) => f.verdict === "untyped").map(row),
  );
  section(
    "RETURNED BUT NOT DECLARED: unreadable without a type error, so harmless unless the name is a typo",
    findings.filter((f) => f.verdict === "undeclared").map(row),
  );
  section(
    "DECLARED BUT NEVER RETURNED: always undefined at runtime. Fine for a shared interface the query only partly fills",
    neverReturned.map(([site, name]) => `${where(site).padEnd(44)} ${name}`),
  );
  section("BUILT AT RUNTIME: not described", runtime.map((s) => `${where(s).padEnd(44)} ${s.unresolved}`));

  const lies = findings.filter((f) => f.verdict === "lie").length;
  console.log(`\n${lies} lies, ${failed.length} undescribed. ${lies + failed.length === 0 ? "PASS" : "FAIL"}`);
  if (lies + failed.length > 0) process.exitCode = 1;
}

// Only when run as the entry point, so the test can import the pieces without
// opening a connection to the live database.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
