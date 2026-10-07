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
// Exits 1 when a declared type disagrees with what the driver delivers, when a
// statement could not be described, or when a query's result is read but its
// statement is only known at runtime. A census that skipped a query has not
// shown that the query is fine.

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

/**
 * The row type a query declares. "any" when nothing is declared, so nothing
 * can be checked. "unknown" when the rows are `unknown`, which is honest: no
 * column can be read without the code narrowing it first. Otherwise its named
 * properties, plus its string index signature if it has one
 * (`Record<string, number>` declares every column a number).
 */
export type RowType =
  | { kind: "any" }
  | { kind: "unknown" }
  | { kind: "typed"; props: Map<string, Declared>; index: Declared | null };

export interface QuerySite {
  /** Relative to backend/, with forward slashes. */
  file: string;
  line: number;
  /** "pg" when the call resolves to node-postgres' own `query`; "structural" for a client typed as `{ query(...) }`. */
  via: "pg" | "structural";
  /**
   * Every statement the call can send, exactly as sent: one for a literal, one
   * per branch for a choice between literals. Empty when built at runtime.
   */
  statements: string[];
  /** What could not be read, when `statements` is empty. */
  unresolved?: string;
  /**
   * Whether anything reads the result. `await client.query(sql);` on a line of
   * its own asserts no row type, so a statement the census cannot read there
   * has nothing to check. Read anywhere else, it is a hole in the census.
   */
  resultUsed: boolean;
  declared: RowType;
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
 * Every database call outside the tests, with the statements it sends and the
 * row type it declares: node-postgres' own `query` however it is reached, and
 * any client typed as `{ query(text) }` (see queryCall). Tests are skipped
 * because their `db` is a fake: what they declare is checked against the
 * fixture, not the database.
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
        const read = statementsOf(statementNode(call.arguments[0]!), checker);
        sites.push({
          file: path.relative(backendDir, file.fileName).split(path.sep).join("/"),
          line: file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1,
          via,
          statements: "statements" in read ? read.statements : [],
          ...("unresolved" in read ? { unresolved: read.unresolved } : {}),
          resultUsed: resultUsed(call),
          declared: declaredRow(call, checker),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return sites;
}

// A database call is node-postgres' own `query`, decided by the declaration the
// call RESOLVES to rather than by how it is spelled, so `pool["query"](...)`
// and a copy made with `pool.query.bind(pool)` count too, and an unrelated
// `.query()` never does. Or it is a `.query()` on some other type whose first
// argument carries SQL text: verifyRebuild and traceOutAndBack type their
// client as `{ query(text) }` so a test can hand them a fake, and the first
// version of this census, matching on pg's declaration alone, never saw those
// queries at all. A Submittable is not a statement, so it is never one.
function queryCall(call: ts.CallExpression, checker: ts.TypeChecker): QuerySite["via"] | null {
  const first = call.arguments[0];
  if (first === undefined || checker.getTypeAtLocation(first).getProperty("submit") !== undefined) return null;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration !== undefined && isPgQuery(declaration)) return "pg";
  return calleeIsQuery(call.expression) && carriesText(first, checker) ? "structural" : null;
}

const isPgQuery = (declaration: ts.Declaration): boolean =>
  /[\\/]@types[\\/]pg[\\/]/.test(declaration.getSourceFile().fileName) &&
  (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) &&
  declaration.name.getText() === "query";

const calleeIsQuery = (callee: ts.Expression): boolean =>
  (ts.isPropertyAccessExpression(callee) && callee.name.text === "query") ||
  (ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    callee.argumentExpression.text === "query");

// Text, a choice between texts, or `{ text }`. A number has a literal type too,
// and `.query(5)` is not SQL.
function carriesText(arg: ts.Expression, checker: ts.TypeChecker): boolean {
  const stringy = (type: ts.Type): boolean =>
    type.isUnion() ? type.types.every((t) => (t.flags & ts.TypeFlags.StringLike) !== 0) : (type.flags & ts.TypeFlags.StringLike) !== 0;
  const type = checker.getTypeAtLocation(arg);
  if (stringy(type)) return true;
  const text = type.getProperty("text");
  return text !== undefined && stringy(checker.getTypeOfSymbolAtLocation(text, arg));
}

// pg also takes a config object, `{ text, values }`. Its statement is the
// `text` property's own node: the property's TYPE has been widened to `string`
// by the time it is part of the object, so it no longer holds the text.
function statementNode(arg: ts.Expression): ts.Expression {
  if (!ts.isObjectLiteralExpression(arg)) return arg;
  for (const property of arg.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === "text") return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === "text") return property.name;
  }
  return arg;
}

// The statements as they are sent, read off their type. TypeScript gives a
// string literal, a constant holding one, and a template whose every
// substitution is a constant all a string literal TYPE, folded to the exact
// text (checked on 5.9: `select ${LIMIT}` with `const LIMIT = 25` types as
// "select 25", through any client). A choice between constants is a union of
// them, and every branch is sent sometime, so every one is described. A first
// version also rebuilt templates span by span; a mutation run showed that code
// could never change an answer, because a span TypeScript cannot fold is a
// span it could not read either.
function statementsOf(node: ts.Expression, checker: ts.TypeChecker): { statements: string[] } | { unresolved: string } {
  const type = checker.getTypeAtLocation(node);
  if (type.isStringLiteral()) return { statements: [type.value] };
  if (type.isUnion() && type.types.every((t) => t.isStringLiteral())) {
    return { statements: type.types.map((t) => (t as ts.StringLiteralType).value) };
  }
  return { unresolved: whatIsUnknown(node, checker) };
}

// Names the part only known at runtime, so the report says where to look.
function whatIsUnknown(node: ts.Expression, checker: ts.TypeChecker): string {
  if (ts.isTemplateExpression(node)) {
    const isConstant = (t: ts.Type) => t.isStringLiteral() || t.isNumberLiteral();
    const runtime = node.templateSpans.find((span) => !isConstant(checker.getTypeAtLocation(span.expression)));
    if (runtime !== undefined) return `\${${runtime.expression.getText()}}`;
  }
  // A wrapper: the statement arrives as a parameter, so what its callers pass
  // is invisible from here. Said outright, because "text" alone reads as a
  // typo rather than as a hole.
  const declaration = ts.isIdentifier(node) ? checker.getSymbolAtLocation(node)?.valueDeclaration : undefined;
  if (declaration !== undefined && ts.isParameter(declaration)) {
    const owner = declaration.parent;
    const name = ts.isFunctionLike(owner) && owner.name !== undefined ? `${owner.name.getText()}()` : "an anonymous function";
    return `${node.getText()}, a parameter of ${name}: what its callers pass is not checked`;
  }
  return node.getText().slice(0, 80);
}

// A result nothing reads asserts no row type: the call, perhaps awaited, is a
// statement of its own. Assigned, returned, chained or passed on, it is read.
function resultUsed(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return !ts.isExpressionStatement(node.parent);
}

// The row type comes from the generic (`db.query<Row>(...)`) or, in a few
// scripts, from a cast on the awaited result (`(await db.query(...)) as
// { rows: Row[] }`). Both end up as the element type of `rows`.
function declaredRow(call: ts.CallExpression, checker: ts.TypeChecker): RowType {
  let outer: ts.Node = call.parent;
  if (ts.isAwaitExpression(outer)) outer = outer.parent;
  while (ts.isParenthesizedExpression(outer)) outer = outer.parent;
  const result =
    ts.isAsExpression(outer) || ts.isTypeAssertionExpression(outer)
      ? checker.getTypeFromTypeNode(outer.type)
      : checker.getAwaitedType(checker.getTypeAtLocation(call));
  const rows = result && checker.getPropertyOfType(result, "rows");
  if (!rows) return { kind: "any" };
  const rowsType = checker.getTypeOfSymbolAtLocation(rows, call);
  const row = checker.isArrayType(rowsType) ? checker.getTypeArguments(rowsType as ts.TypeReference)[0] : undefined;
  if (!row || row.flags & ts.TypeFlags.Any) return { kind: "any" };
  if (row.flags & ts.TypeFlags.Unknown) return { kind: "unknown" };
  // A type parameter (`query<T>` inside a generic wrapper) is judged by its
  // constraint: the checker resolves that itself in both calls below. An explicit
  // getApparentType here was shown by a mutation run to change nothing.
  const props = new Map<string, Declared>();
  for (const property of checker.getPropertiesOfType(row)) {
    props.set(property.name, declaredOf(checker.getTypeOfSymbolAtLocation(property, call), checker));
  }
  const index = checker.getIndexInfoOfType(row, ts.IndexKind.String);
  return { kind: "typed", props, index: index ? declaredOf(index.type, checker) : null };
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
  // Parsed into whatever shape the document has, whatever one sample makes of it.
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
    // The sample was not text this parser takes, so the shape is not known.
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

const UNKNOWN: Declared = { kinds: new Set(["unknown"]), elements: new Set() };

/** What a row type declares for one returned column. */
export function declaredColumn(row: RowType, column: string): { declared: Declared | undefined; rowIsAny: boolean } {
  if (row.kind === "any") return { declared: undefined, rowIsAny: true };
  if (row.kind === "unknown") return { declared: UNKNOWN, rowIsAny: false };
  return { declared: row.props.get(column) ?? row.index ?? undefined, rowIsAny: false };
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
 * Runs `work` inside BEGIN READ ONLY and always rolls back, so nothing it does
 * can be kept: the second guard, behind DescribeStatement never executing.
 */
export async function withReadOnlyTransaction<T>(
  client: { query(text: string): Promise<unknown> },
  work: () => Promise<T>,
): Promise<T> {
  await client.query("begin read only");
  try {
    return await work();
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
}

/**
 * Describes each statement in turn, on a client already inside a transaction.
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

export interface Finding {
  site: QuerySite;
  /** Which of the site's statements, when it can send more than one. */
  statement: number;
  column: string;
  typname: string;
  delivered: Delivered;
  declared: Declared | undefined;
  verdict: Verdict;
}

export interface Census {
  findings: Finding[];
  /** A statement the database would not describe. */
  undescribed: { site: QuerySite; error: string }[];
  /** The result is read, but the statement is only known at runtime. */
  unchecked: QuerySite[];
  /** Built at runtime, and nothing reads the result: nothing to check. */
  unread: QuerySite[];
  neverReturned: { site: QuerySite; name: string }[];
  pass: boolean;
}

/**
 * The verdict, from what the code declares and what the database described.
 * Pure, so the rules that decide pass and fail are tested without a database.
 */
export function judgeCensus(
  sites: QuerySite[],
  described: Map<QuerySite, Description[]>,
  types: Map<number, ColumnType>,
  parserFor: (oid: number) => ((text: string) => unknown) | undefined = configuredParser,
): Census {
  const census: Census = { findings: [], undescribed: [], unchecked: [], unread: [], neverReturned: [], pass: false };
  for (const site of sites) {
    if (site.statements.length === 0) {
      (site.resultUsed ? census.unchecked : census.unread).push(site);
      continue;
    }
    const descriptions = described.get(site) ?? [];
    if (descriptions.length !== site.statements.length) {
      census.undescribed.push({ site, error: "not described" });
      continue;
    }
    const returned = new Set<string>();
    descriptions.forEach((description, statement) => {
      if ("error" in description) {
        census.undescribed.push({ site, error: description.error });
        return;
      }
      for (const column of description.columns) {
        returned.add(column.name);
        const type = types.get(column.oid);
        if (type === undefined) throw new Error(`${where(site)}: no pg_type row for oid ${column.oid}`);
        const delivered = deliveredShape(type, parserFor(column.oid));
        const { declared, rowIsAny } = declaredColumn(site.declared, column.name);
        census.findings.push({
          site,
          statement,
          column: column.name,
          typname: type.typname,
          delivered,
          declared,
          verdict: judge(delivered, declared, rowIsAny),
        });
      }
    });
    if (site.declared.kind === "typed") {
      for (const name of site.declared.props.keys()) if (!returned.has(name)) census.neverReturned.push({ site, name });
    }
  }
  const lies = census.findings.filter((f) => f.verdict === "lie").length;
  census.pass = lies === 0 && census.undescribed.length === 0 && census.unchecked.length === 0;
  return census;
}

interface TypeRow extends ColumnType {
  oid: number;
}

const where = (site: QuerySite): string => `${site.file}:${site.line}`;

async function main(): Promise<void> {
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sites = findQuerySites(loadProgram(backendDir), backendDir);

  const described = new Map<QuerySite, Description[]>();
  const types = new Map<number, ColumnType>();
  const client = await pool.connect();
  try {
    await withReadOnlyTransaction(client, async () => {
      const readable = sites.filter((site) => site.statements.length > 0);
      const descriptions = await describeAll(client, readable.flatMap((site) => site.statements));
      let next = 0;
      for (const site of readable) {
        described.set(site, descriptions.slice(next, next + site.statements.length));
        next += site.statements.length;
      }
      const oids = [...new Set(descriptions.flatMap((d) => ("columns" in d ? d.columns : []).map((c) => c.oid)))];
      const { rows } = await client.query<TypeRow>(
        `select t.oid::int as oid, t.typname::text as typname, t.typcategory::text as category,
                e.typcategory::text as "elementCategory"
           from pg_type t
           left join pg_type e on e.oid = t.typelem and t.typcategory = 'A'
          where t.oid = any($1::int[])`,
        [oids],
      );
      for (const row of rows) types.set(row.oid, row);
    });
  } finally {
    client.release();
    await pool.end();
  }

  const census = judgeCensus(sites, described, types);
  const int8 = configuredParser(20);
  const statements = sites.reduce((n, s) => n + s.statements.length, 0);
  const withColumns = sites.filter((s) => (described.get(s) ?? []).some((d) => "columns" in d && d.columns.length > 0));
  console.log(`query-type census: what the database returns, against what the code declares`);
  console.log(`driver in this process: bigint arrives as ${int8 ? kindOfValue(int8("1")) : "string"}\n`);
  console.log(
    `${sites.length} query call sites (${sites.filter((s) => s.via === "structural").length} through a client typed as ` +
      `\`{ query }\` rather than pg's), ${statements} statements described: ${withColumns.length} sites return columns, ` +
      `${census.unread.length + census.unchecked.length} built at runtime, ${census.undescribed.length} could not be described`,
  );

  const section = (title: string, lines: string[]): void => {
    if (lines.length === 0) return;
    console.log(`\n${title} (${lines.length})`);
    for (const line of lines) console.log(`  ${line}`);
  };
  const at = (f: Finding): string => (f.site.statements.length > 1 ? `${where(f.site)} [${f.statement + 1}]` : where(f.site));
  const row = (f: Finding): string =>
    `${at(f).padEnd(44)} ${f.column.padEnd(18)} ${f.typname.padEnd(10)} -> ${showDelivered(f.delivered).padEnd(9)}` +
    (f.declared ? ` declared ${showDeclared(f.declared)}` : "");

  section("LIES: the declared type does not admit what the driver delivers", census.findings.filter((f) => f.verdict === "lie").map(row));
  section("COULD NOT BE DESCRIBED", census.undescribed.map(({ site, error }) => `${where(site).padEnd(44)} ${error}`));
  section(
    "UNCHECKED: the result is read, but the statement is only known at runtime",
    census.unchecked.map((s) => `${where(s).padEnd(44)} ${s.unresolved}`),
  );
  section(
    "UNTYPED: rows are `any`, so the code reading them cannot be checked here. Read each by hand",
    census.findings.filter((f) => f.verdict === "untyped").map(row),
  );
  section(
    "RETURNED BUT NOT DECLARED: unreadable without a type error, so harmless unless the name is a typo",
    census.findings.filter((f) => f.verdict === "undeclared").map(row),
  );
  section(
    "DECLARED BUT NEVER RETURNED: always undefined at runtime. Fine for a shared interface the query only partly fills",
    census.neverReturned.map(({ site, name }) => `${where(site).padEnd(44)} ${name}`),
  );
  section(
    "BUILT AT RUNTIME, RESULT NOT READ: no row type is asserted, so nothing to check",
    census.unread.map((s) => `${where(s).padEnd(44)} ${s.unresolved}`),
  );

  const lies = census.findings.filter((f) => f.verdict === "lie").length;
  console.log(
    `\n${lies} lies, ${census.undescribed.length} undescribed, ${census.unchecked.length} unchecked. ` +
      `${census.pass ? "PASS" : "FAIL"}`,
  );
  if (!census.pass) process.exitCode = 1;
}

// Only when run as the entry point, so the test can import the pieces without
// opening a connection to the live database.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
