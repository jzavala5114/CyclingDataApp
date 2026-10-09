import "dotenv/config";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import ts from "typescript";
import { pool } from "../db/pool.js";

// Asks the live database what every query in backend/src returns, and checks
// that against the row type the code declares for it.
//
// The generic on `db.query<T>` is an assertion. node-postgres never sees it: it
// hands JS whatever its parser for each column's Postgres type produces. So for
// the life of the project `bigint` ids arrived as TEXT while nine fields across
// five interfaces said `number` (paid-for #30), and nothing could notice. The
// compiler checks code against the declared type, and the tests feed fixtures
// built from that same declared type. Only the database knows what a column
// is, so this asks it.
//
// It executes nothing. Each statement goes out as Parse + Describe + Sync, the
// messages a driver uses to learn a statement's result columns before binding
// it, so an INSERT ... RETURNING is described without being run. The session
// also sits inside BEGIN READ ONLY, so a statement that somehow did execute
// could not write. `DescribeStatement` is tested for the first, and
// `runCensus`, which is everything the command does after finding the queries,
// is tested for both against a fake client that records what it is sent.
// `censusCommand`, which finds them, is run over the real program in a test.
//
// Its reach is the TypeScript program `npm run typecheck` sees, tests excluded.
// A module that program imports as JavaScript, with only a declaration file
// here, is code the census cannot read: it fails the census unless
// ACCEPTED_OUTSIDE names it with the reason it is safe.
//
// Read-only.
//
//   npm run eval:query-types
//
// Exits 1 when a declared type disagrees with what the driver delivers, when a
// statement could not be described, when a query's result is read but its
// statement is not readable here (built at runtime, or a Submittable), when a
// query's rows are read but typed `any`, when a declared column comes back
// under a lower-cased name, when it found no queries at all, or when the
// program runs code outside its reach that ACCEPTED_OUTSIDE does not name (or
// names, and the program no longer has). A census that skipped a query has not
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
   * per branch for a choice between literals. Empty when built at runtime, or
   * when the call hands pg a Submittable, which sends its own messages.
   */
  statements: string[];
  /** What could not be read, when `statements` is empty. */
  unresolved?: string;
  /**
   * Whether anything reads the result. `await client.query(sql);` on a line of
   * its own asserts no row type, so a statement the census cannot read there
   * has nothing to check. Read anywhere else, including by a callback, it is a
   * hole in the census.
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

const relative = (backendDir: string, fileName: string): string =>
  path.relative(backendDir, fileName).split(path.sep).join("/");

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
        const submitted = submittableOf(call.arguments[0]!, checker);
        const read: { statements: string[] } | { unresolved: string } =
          submitted === null ? statementsOf(statementNode(call.arguments[0]!), checker) : { unresolved: submitted.what };
        sites.push({
          file: relative(backendDir, file.fileName),
          line: file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1,
          via,
          statements: "statements" in read ? read.statements : [],
          ...("unresolved" in read ? { unresolved: read.unresolved } : {}),
          resultUsed: submitted === null ? resultUsed(call, checker) : submitted.delivers,
          declared: declaredRow(call, checker),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return sites;
}

/**
 * Declaration files outside node_modules: the code behind each is outside what
 * the census reads. Today that is one, osm-pipeline's linkPlan.d.mts, through
 * which evalLinkerFold.ts runs linkPlan.mjs on the backend's own client. Its
 * queries are not checked here, so it fails the census unless ACCEPTED_OUTSIDE
 * names it.
 */
export function unreadModules(program: ts.Program, backendDir: string): string[] {
  // TypeScript's own lib files live in node_modules too, so they are excluded here.
  return program
    .getSourceFiles()
    .filter((file) => file.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(file.fileName))
    .map((file) => relative(backendDir, file.fileName));
}

/**
 * Code the program runs that the census cannot read, each read by hand, with
 * why it is safe. Anything else outside the census fails it, and so does an
 * entry here whose module the program no longer has, so this list cannot rot.
 */
export const ACCEPTED_OUTSIDE: Readonly<Record<string, string>> = {
  "../osm-pipeline/scripts/lib/linkPlan.d.mts":
    "osm-pipeline's linkPlan.mjs. The backend runs two of its functions, from " +
    "evalLinkerFold.ts, a local tool the server never loads: decide, which is pure, " +
    "and buildLinkPlan, the only one that queries. That reads every id through " +
    "Number() and its node ids out of json_agg, so it computes the same on either " +
    "driver. Its write path, applyWrites, runs only from osm-pipeline itself.",
};

// A database call is node-postgres' own `query`, decided by the declaration the
// call RESOLVES to rather than by how it is spelled, so `pool["query"](...)`
// and a copy made with `pool.query.bind(pool)` count too, and an unrelated
// `.query()` never does. Or it is a `.query()` on some other type whose first
// argument carries SQL text: verifyRebuild and traceOutAndBack type their
// client as `{ query(text) }` so a test can hand them a fake, and the first
// version of this census, matching on pg's declaration alone, never saw those
// queries at all.
function queryCall(call: ts.CallExpression, checker: ts.TypeChecker): QuerySite["via"] | null {
  const first = call.arguments[0];
  if (first === undefined) return null;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration !== undefined && isPgQuery(declaration)) return "pg";
  return calleeIsQuery(call.expression) && carriesText(first, checker) ? "structural" : null;
}

// An argument the census cannot see into: typed `any`, or `never` (what a
// cast `as never` leaves, assignable anywhere), or a spread of arguments. It
// could be a callback or a Submittable, so it is assumed to be the kind that
// reads the result. A cold review passed a typed callback through each of
// these and the census filed it as unread.
const opaque = (arg: ts.Expression, checker: ts.TypeChecker): boolean =>
  ts.isSpreadElement(arg) || (checker.getTypeAtLocation(arg).flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)) !== 0;

// A Submittable is an object pg hands the connection to: a `pg.Query`, a
// cursor, a stream. It sends its own messages, so its statement cannot be read
// here, and its rows reach the code through the object itself, never through
// the call's value. So it counts as read, and fails the census, unless it is
// the census's own DescribeStatement, which executes nothing and so delivers
// no rows at all. A first version dropped every Submittable without a line,
// and a `new pg.Query("select id from segments")` vanished from the report.
// An opaque argument could be one, so it counts as one.
function submittableOf(arg: ts.Expression, checker: ts.TypeChecker): { what: string; delivers: boolean } | null {
  if (opaque(arg, checker)) {
    return {
      what: "an argument the census cannot see into (typed `any` or `never`, or spread): it may be a Submittable, whose statement and rows are not visible here",
      delivers: true,
    };
  }
  const type = checker.getTypeAtLocation(arg);
  if (type.getProperty("submit") === undefined) return null;
  const symbol = type.getSymbol();
  // An anonymous type's symbol is called "__type", which names nothing.
  const name = symbol !== undefined && !symbol.getName().startsWith("__") ? symbol.getName() : checker.typeToString(type);
  const declaredHere = symbol?.declarations?.some((d) => /[\\/]evalQueryTypes\.ts$/.test(d.getSourceFile().fileName));
  if (name === "DescribeStatement" && declaredHere === true) {
    return { what: "DescribeStatement: the census's own Parse + Describe, which executes nothing", delivers: false };
  }
  return { what: `a Submittable (${name}): it sends its own messages, so its statement is not read here`, delivers: true };
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
// statement of its own. Assigned, returned, chained or passed on, it is read,
// and so it is when the call hands pg a callback, which receives the result
// however the call itself stands: `pool.query(sql, (err, r) => r.rows...)`.
// An opaque argument may be that callback: pg takes a function in the values
// slot as one, and the census cannot see what it is.
function resultUsed(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (callbackOf(call, checker) !== undefined) return true;
  if (call.arguments.slice(1).some((arg) => opaque(arg, checker))) return true;
  let node: ts.Node = call;
  while (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return !ts.isExpressionStatement(node.parent);
}

// pg's callback style: a function among the arguments after the statement.
function callbackOf(call: ts.CallExpression, checker: ts.TypeChecker): { arg: ts.Expression; signature: ts.Signature } | undefined {
  for (const arg of call.arguments.slice(1)) {
    const [signature] = checker.getTypeAtLocation(arg).getCallSignatures();
    if (signature !== undefined) return { arg, signature };
  }
  return undefined;
}

// The row type comes from the generic (`db.query<Row>(...)`), from a cast on
// the result, awaited (`(await db.query(...)) as { rows: Row[] }`) or not
// (`await (db.query(...) as Promise<QueryResult<Row>>)`), or from the result
// parameter of a callback (`(err, r: QueryResult<Row>) => ...`). All of them
// end up as the element type of `rows`. Anything else, a cast on `.rows`
// itself, rows handed to a typed function, comes out `any`: unchecked, which
// fails the census when the rows are read, so it cannot pass by accident.
function declaredRow(call: ts.CallExpression, checker: ts.TypeChecker): RowType {
  let node: ts.Node = call;
  let cast: ts.TypeNode | undefined;
  for (;;) {
    const parent = node.parent;
    if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) cast = parent.type;
    else if (!ts.isAwaitExpression(parent) && !ts.isParenthesizedExpression(parent)) break;
    node = parent;
  }
  const callback = callbackOf(call, checker);
  const resultParameter = callback?.signature.getParameters()[1];
  const result =
    cast !== undefined
      ? checker.getAwaitedType(checker.getTypeFromTypeNode(cast))
      : resultParameter !== undefined
        ? checker.getTypeOfSymbolAtLocation(resultParameter, callback!.arg)
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
  /** The result is read, but the statement is not readable here: built at runtime, or a Submittable. */
  unchecked: QuerySite[];
  /** No statement to read, and nothing reads a result: nothing to check. */
  unread: QuerySite[];
  /** Columns returned to code that reads them through `any`: nothing checks that code. */
  untypedRead: Finding[];
  neverReturned: { site: QuerySite; name: string }[];
  /**
   * A declared column that never comes back while its lower-cased name does.
   * Postgres folds an unquoted alias to lower case, so `as segmentId` returns
   * `segmentid` and the declared `segmentId` is undefined on every row.
   */
  caseFolded: { site: QuerySite; name: string }[];
  /** Code outside the census that ACCEPTED_OUTSIDE names, with why it is safe. */
  outside: { module: string; why: string }[];
  /** Code outside the census that nothing accepts: unread, so it fails. */
  unacceptedOutside: string[];
  /** Accepted modules the program no longer has: the list has gone stale. */
  acceptedGone: string[];
  pass: boolean;
}

/** What the program runs beyond the census's reach, and what has been accepted. */
export interface Scope {
  /** What unreadModules found. */
  outside: string[];
  /** ACCEPTED_OUTSIDE in the command; a test's own list in a test. */
  accepted: Readonly<Record<string, string>>;
}

const NOTHING_OUTSIDE: Scope = { outside: [], accepted: {} };

/**
 * The verdict, from what the code declares and what the database described.
 * Pure, so the rules that decide pass and fail are tested without a database.
 */
export function judgeCensus(
  sites: QuerySite[],
  described: Map<QuerySite, Description[]>,
  types: Map<number, ColumnType>,
  parserFor: (oid: number) => ((text: string) => unknown) | undefined = configuredParser,
  scope: Scope = NOTHING_OUTSIDE,
): Census {
  const census: Census = {
    findings: [],
    undescribed: [],
    unchecked: [],
    unread: [],
    untypedRead: [],
    neverReturned: [],
    caseFolded: [],
    outside: [],
    unacceptedOutside: [],
    acceptedGone: [],
    pass: false,
  };
  for (const module of scope.outside) {
    if (Object.hasOwn(scope.accepted, module)) census.outside.push({ module, why: scope.accepted[module]! });
    else census.unacceptedOutside.push(module);
  }
  census.acceptedGone = Object.keys(scope.accepted).filter((module) => !scope.outside.includes(module));
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
      for (const name of site.declared.props.keys()) {
        if (returned.has(name)) continue;
        const folded = name.toLowerCase();
        (folded !== name && returned.has(folded) ? census.caseFolded : census.neverReturned).push({ site, name });
      }
    }
  }
  // Rows typed `any` that nothing reads assert nothing. Read, they are code the
  // census passed without checking: the findHoles crash, `.padStart` on an int8,
  // passed exactly that way once its row type was taken away.
  census.untypedRead = census.findings.filter((f) => f.verdict === "untyped" && f.site.resultUsed);
  const lies = census.findings.filter((f) => f.verdict === "lie").length;
  // A census that found no queries has checked nothing, however clean it reads.
  census.pass =
    sites.length > 0 &&
    lies === 0 &&
    census.undescribed.length === 0 &&
    census.unchecked.length === 0 &&
    census.untypedRead.length === 0 &&
    census.caseFolded.length === 0 &&
    census.unacceptedOutside.length === 0 &&
    census.acceptedGone.length === 0;
  return census;
}

interface TypeRow extends ColumnType {
  oid: number;
}

const where = (site: QuerySite): string => `${site.file}:${site.line}`;

/**
 * Everything the command does once it has found the queries: describe every
 * statement inside a read-only transaction, look up the column types, judge,
 * print the report, and fail the process when the census fails. It is handed
 * the connection rather than opening one, so the test drives it with a fake
 * that records what it is sent. What reaches the live database, and whether a
 * failing census fails the process, are the two promises this file makes, and
 * a cold review showed that while main() held this code, it could break either
 * with every test green: executing statements outside READ ONLY would have run
 * rebuildModel's three DELETEs against the production model.
 */
export async function runCensus(
  client: pg.PoolClient,
  sites: QuerySite[],
  scope: Scope = NOTHING_OUTSIDE,
  log: (line: string) => void = console.log,
): Promise<Census> {
  const described = new Map<QuerySite, Description[]>();
  const types = new Map<number, ColumnType>();
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
  const census = judgeCensus(sites, described, types, configuredParser, scope);
  for (const line of report(sites, described, census)) log(line);
  if (!census.pass) process.exitCode = 1;
  return census;
}

/**
 * The command over a whole program: every query findQuerySites finds in it,
 * with the code it cannot read judged against ACCEPTED_OUTSIDE. A cold review
 * dropped that list from main() and every test passed, so this wiring is run
 * over the real program in a test too.
 */
export function censusCommand(
  client: pg.PoolClient,
  program: ts.Program,
  backendDir: string,
  log: (line: string) => void = console.log,
): Promise<Census> {
  const scope = { outside: unreadModules(program, backendDir), accepted: ACCEPTED_OUTSIDE };
  return runCensus(client, findQuerySites(program, backendDir), scope, log);
}

function report(sites: QuerySite[], described: Map<QuerySite, Description[]>, census: Census): string[] {
  const out: string[] = [];
  const int8 = configuredParser(20);
  const statements = sites.reduce((n, s) => n + s.statements.length, 0);
  const withColumns = sites.filter((s) => (described.get(s) ?? []).some((d) => "columns" in d && d.columns.length > 0));
  out.push(`query-type census: what the database returns, against what the code declares`);
  out.push(`driver in this process: bigint arrives as ${int8 ? kindOfValue(int8("1")) : "string"}`, "");
  out.push(
    `${sites.length} query call sites (${sites.filter((s) => s.via === "structural").length} through a client typed as ` +
      `\`{ query }\` rather than pg's), ${statements} statements described: ${withColumns.length} sites return columns, ` +
      `${census.unread.length + census.unchecked.length} with no statement readable here, ` +
      `${census.undescribed.length} could not be described`,
  );

  const section = (title: string, lines: string[]): void => {
    if (lines.length === 0) return;
    out.push("", `${title} (${lines.length})`, ...lines.map((line) => `  ${line}`));
  };
  const at = (f: Finding): string => (f.site.statements.length > 1 ? `${where(f.site)} [${f.statement + 1}]` : where(f.site));
  const row = (f: Finding): string =>
    `${at(f).padEnd(44)} ${f.column.padEnd(18)} ${f.typname.padEnd(10)} -> ${showDelivered(f.delivered).padEnd(9)}` +
    (f.declared ? ` declared ${showDeclared(f.declared)}` : "");
  const name = ({ site, name }: { site: QuerySite; name: string }): string => `${where(site).padEnd(44)} ${name}`;
  const unresolved = (s: QuerySite): string => `${where(s).padEnd(44)} ${s.unresolved}`;

  if (sites.length === 0) out.push("", "NO QUERY SITES: a census that found nothing has checked nothing");
  section("LIES: the declared type does not admit what the driver delivers", census.findings.filter((f) => f.verdict === "lie").map(row));
  section("COULD NOT BE DESCRIBED", census.undescribed.map(({ site, error }) => `${where(site).padEnd(44)} ${error}`));
  section("UNCHECKED: the result is read, but its statement is not readable here", census.unchecked.map(unresolved));
  section(
    "UNTYPED AND READ: rows are `any` and the code reads them, so nothing checks that code. Declare the row type",
    census.untypedRead.map(row),
  );
  section(
    "FOLDED TO LOWER CASE: Postgres returns an unquoted alias in lower case, so this declared column is always undefined. Quote the alias",
    census.caseFolded.map(name),
  );
  section(
    "OUTSIDE THE CENSUS, NOT ACCEPTED: code the program runs that the census cannot read. " +
      "Bring it into the program, or add it to ACCEPTED_OUTSIDE with why it is safe",
    census.unacceptedOutside,
  );
  section("ACCEPTED BUT GONE: ACCEPTED_OUTSIDE names a module the program no longer has. Remove it", census.acceptedGone);
  section(
    "RETURNED BUT NOT DECLARED: unreadable without a type error, so harmless unless the name is a typo",
    census.findings.filter((f) => f.verdict === "undeclared").map(row),
  );
  section(
    "DECLARED BUT NEVER RETURNED: always undefined at runtime. Fine for a shared interface the query only partly fills",
    census.neverReturned.map(name),
  );
  section(
    "UNTYPED, NOT READ: rows are `any`, but nothing reads the result",
    census.findings.filter((f) => f.verdict === "untyped" && !f.site.resultUsed).map(row),
  );
  section("NOTHING TO CHECK: no statement readable here, and nothing reads a result", census.unread.map(unresolved));
  section(
    "OUTSIDE THE CENSUS, ACCEPTED BY HAND: the program runs it, the census cannot read it, and this is why that is safe",
    census.outside.map(({ module, why }) => `${module}: ${why}`),
  );

  const lies = census.findings.filter((f) => f.verdict === "lie").length;
  const untypedSites = new Set(census.untypedRead.map((f) => f.site)).size;
  const unaccepted = census.unacceptedOutside.length + census.acceptedGone.length;
  out.push(
    "",
    `${lies} lies, ${census.undescribed.length} undescribed, ${census.unchecked.length} unchecked, ` +
      `${untypedSites} untyped and read, ${census.caseFolded.length} folded, ${unaccepted} outside unaccepted. ` +
      `${census.pass ? "PASS" : "FAIL"}`,
  );
  return out;
}

async function main(): Promise<void> {
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const program = loadProgram(backendDir);
  const client = await pool.connect();
  try {
    await censusCommand(client, program, backendDir);
  } finally {
    client.release();
    await pool.end();
  }
}

// Only when run as the entry point, so the test can import the pieces without
// opening a connection to the live database.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
