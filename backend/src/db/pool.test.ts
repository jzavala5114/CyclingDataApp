import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import ts from "typescript";

// The server and every script reach the database through db/pool.ts, and the
// only thing making their ids numbers is that pool.ts loads db/pgTypes.ts. Drop
// that import and production silently goes back to ids as text, which no other
// gate test would notice: the type tests import pgTypes.ts by name. So this
// file observes the driver, imports pool.ts and nothing else, and observes it
// again. Building the Pool opens no connection; that waits for the first query.

type TypeId = Parameters<typeof pg.types.getTypeParser>[0];
const parserFor = (oid: number) => pg.types.getTypeParser(oid as TypeId, "text") as (text: string) => unknown;
const before = parserFor(20)("84");
const poolModule = await import("./pool.js");
const { pool } = poolModule;
// Only now, so the observation above saw what pool.ts did and nothing else.
const { int8FromText, int8ArrayFromText } = await import("./pgTypes.js");

test("importing db/pool.ts is what makes a bigint arrive as a number", () => {
  assert.equal(before, "84", "nothing in this file configured the driver before pool.ts did");
  assert.equal(parserFor(20)("84"), 84);
});

test("db/pool.ts hands out one thing, the checked pool, and never pg's own Pool", () => {
  // A cold review's round 6: `export { Pool }` added to pool.ts, the one file
  // the scan below lets import pg's Pool, handed a script a second Pool with
  // no checkout check and no connection timeout, and every test passed.
  assert.deepEqual(Object.keys(poolModule), ["pool"]);
});

test("...EXACTLY OR NOT AT ALL: past 2^53 the driver pool.ts leaves in place throws, never rounds", () => {
  // A cold review's two survivors: pool.ts swapping pgTypes.ts for the common
  // `setTypeParser(20, Number)`, or keeping it and then registering the widely
  // copied `parseInt` override after it. Both turn 9007199254740993 into
  // ...992, two ids quietly becoming one, and both passed every test while
  // this file checked only "84".
  assert.equal(parserFor(20)("9007199254740991"), 9007199254740991);
  assert.throws(() => parserFor(20)("9007199254740993"), /9007199254740993/);
  assert.deepEqual(parserFor(1016)("{1,NULL}"), [1, null]);
  assert.throws(() => parserFor(1016)("{1,9007199254740993}"), /9007199254740993/);
});

// -- the tripwire: a parser replaced later in the process -----------------------

/** Puts pgTypes.ts's parsers back, as importing it left them. */
const reinstall = (): void => {
  pg.types.setTypeParser(20 as TypeId, int8FromText);
  pg.types.setTypeParser(1016 as TypeId, int8ArrayFromText);
};

const REPLACEMENTS: [string, () => void, RegExp][] = [
  ["pg.defaults.parseInt8 = true (parseInt: rounds)", () => void (pg.defaults.parseInt8 = true), /int8 \(20\) and int8\[\] \(1016\)/],
  ["pg.defaults.parseInt8 = false (text again)", () => void (pg.defaults.parseInt8 = false), /int8 \(20\) and int8\[\] \(1016\)/],
  ["setTypeParser(20, Number)", () => pg.types.setTypeParser(20 as TypeId, Number), /int8 \(20\) parser/],
  ["the int8[] parser alone", () => pg.types.setTypeParser(1016 as TypeId, (text: string) => text), /int8\[\] \(1016\) parser/],
];

type Handed = pg.Client & { release: (err?: unknown) => void; released: unknown[]; queried: string[] };

/**
 * A real pg Client, never connected, as the pool's connection step hands one
 * out: its parsers are looked up by pg's own code, from the registry or from
 * the `types` it was given. Its query answers with one row and records the
 * text, and its release records what it was released with.
 */
function handed(config?: pg.ClientConfig): Handed {
  const client = new pg.Client(config) as Handed;
  client.released = [];
  client.queried = [];
  client.release = (err?: unknown) => void client.released.push(err);
  client.query = ((text: string, _values: unknown, callback: (err: Error | undefined, result: unknown) => void) => {
    client.queried.push(text);
    process.nextTick(() => callback(undefined, { rows: [{ id: 84 }] }));
  }) as never;
  return client;
}

/**
 * The pool's real connection step, replaced: it hands out `client`, either way
 * pg-pool can be asked. Like pg-pool, its `done` is the client's own release.
 */
const handOut = (t: { mock: { method: typeof import("node:test").mock.method } }, client: Handed) =>
  t.mock.method(pg.Pool.prototype, "connect", function (callback?: (err: undefined, c: Handed, done: (err?: unknown) => void) => void) {
    if (callback === undefined) return Promise.resolve(client);
    process.nextTick(() => callback(undefined, client, client.release));
    return undefined;
  } as never);

test("A HEALTHY QUERY goes through the checkout, both ways pg-pool asks for one", { timeout: 2000 }, async (t) => {
  // pool.query checks out with a CALLBACK (pg-pool's query calls
  // this.connect(cb)), and every route uses pool.query. A cold review made
  // that branch drop the callback, so every query hung, and every test passed.
  const client = handed();
  const reached = handOut(t, client);
  const result = await pool.query("select 1");
  assert.deepEqual(result.rows, [{ id: 84 }]);
  assert.deepEqual(client.queried, ["select 1"]);
  assert.deepEqual(client.released, [undefined], "released after the query, back to the pool");
  assert.equal(await pool.connect(), client);
  const viaCallback = await new Promise((resolve, reject) => pool.connect((err, c) => (err ? reject(err) : resolve(c))));
  assert.equal(viaCallback, client);
  assert.equal(reached.mock.callCount(), 3);
});

test("A CONNECTION THAT FAILS reaches the caller as its own error, both ways pg-pool asks for one", { timeout: 2000 }, async (t) => {
  // With the database down, pg-pool answers a checkout with (err, undefined,
  // done). A cold review's round 5 made the checkout swallow that, so every
  // query hung through an outage, or pass it on as no error, so pg-pool's
  // query called `.once` on the missing client and crashed the process. Both
  // passed every test, which only ever handed out a client.
  const down = new Error("connect ECONNREFUSED 127.0.0.1:5432");
  const reached = t.mock.method(pg.Pool.prototype, "connect", function (callback?: (err: Error, c: undefined, done: () => void) => void) {
    if (callback === undefined) return Promise.reject(down);
    process.nextTick(() => callback(down, undefined, () => undefined));
    return undefined;
  } as never);
  await assert.rejects(pool.query("select 1"), (err) => err === down, "pool.query");
  await assert.rejects(pool.connect(), (err) => err === down, "pool.connect()");
  const viaCallback = await new Promise<unknown[]>((resolve) => pool.connect((err, c) => resolve([err, c])));
  assert.deepEqual(viaCallback, [down, undefined], "pool.connect(callback)");
  assert.equal(reached.mock.callCount(), 3);
});

test("THE TRIPWIRE: a parser replaced after pool.ts loaded fails every checkout and query, with the reason, before connecting", { timeout: 2000 }, async (t) => {
  // A cold review's round 3: `pg.defaults.parseInt8 = true` in src/index.ts
  // made the server round ids past 2^53, and `= false` made them text again,
  // with every test green. A line like that can sit in any file, under any
  // spelling, so pool.ts checks the registry itself on each checkout. With a
  // parser replaced, nothing may reach the connection step.
  const reached = handOut(t, handed());
  try {
    for (const [what, replace, names] of REPLACEMENTS) {
      replace();
      await assert.rejects(pool.query("select 1"), names, `pool.query after ${what}`);
      await assert.rejects(pool.connect(), /no longer the one db\/pgTypes\.ts installed/, `pool.connect() after ${what}`);
      const viaCallback = await new Promise<Error | undefined>((resolve) => pool.connect((err) => resolve(err)));
      assert.match(String(viaCallback), /no longer the one db\/pgTypes\.ts installed/, `pool.connect(callback) after ${what}`);
      reinstall();
    }
    assert.equal(reached.mock.callCount(), 0, "a checkout with a replaced parser reached the connection step");
  } finally {
    reinstall();
  }
});

test("A CLIENT WITH PARSERS OF ITS OWN, or set to binary, is refused at checkout and removed from the pool", { timeout: 2000 }, async (t) => {
  // A cold review's round 4: `pool.options.types = { getTypeParser }` got past
  // a tripwire that read only the registry, because pg asks a client's own
  // `types` first, and the server rounded past 2^53 without a word. So the
  // client a checkout hands out is checked too, through pg's own lookup. Its
  // round 5: `binary ||= 1` got past a check for `=== true`, and pg, which
  // tests truthiness, sent int8 back as text.
  const rounding = { getTypeParser: (oid: number, format?: string) => (oid === 20 ? Number : pg.types.getTypeParser(oid as TypeId, format as "text")) };
  for (const [what, config, reason] of [
    ["a Pool given its own types", { types: rounding }, /a checked-out client's int8 \(20\) parser is not the one db\/pgTypes\.ts installed/],
    ["a Pool set to binary", { binary: true }, /asks for binary results/],
    ["a Pool set to binary by a truthy value", { binary: 1 as unknown as boolean }, /asks for binary results/],
    // ...or by a string, as an environment variable would give it (round 6).
    ["a Pool set to binary by a string", { binary: "true" as unknown as boolean }, /asks for binary results/],
  ] as [string, pg.ClientConfig, RegExp][]) {
    const client = handed(config);
    const reached = handOut(t, client);
    await assert.rejects(pool.query("select 1"), reason, `pool.query, ${what}`);
    await assert.rejects(pool.connect(), reason, `pool.connect(), ${what}`);
    const viaCallback = await new Promise<Error | undefined>((resolve) => pool.connect((err) => resolve(err)));
    assert.match(String(viaCallback), reason, `pool.connect(callback), ${what}`);
    assert.deepEqual(client.queried, [], `${what}: nothing was sent on it`);
    assert.equal(client.released.length, 3, `${what}: every refused client was released`);
    assert.ok(client.released.every((err) => err instanceof Error), `${what}: released WITH the error, so pg-pool removes it`);
    reached.mock.restore();
  }
});

// -- the scan: what the tripwire cannot see ------------------------------------

// The tripwire guards the one Pool, and reads only what a client gets from it.
// A script that built a Pool of its own would never pass through it, and in a
// process that never loads pool.ts, ids are text again; parsers or binary
// given to a single query (`pool.query({ text, types })`) never reach a
// checkout at all. The census cannot notice either: it judges every query with
// its own process's driver. Cold reviews built a second Pool in findHoles.ts,
// reached pg's Pool through a re-export, and gave findHoles' bucket query
// rounding parsers under a computed key, and every test passed. So this reads
// every source file, as written and without types, for:
//   - outside db/pool.ts, pg's Pool or Client imported, reached as a
//     property or a destructured name, or aliased (`import P = pgx.Pool`),
//     and pg-pool imported;
//   - anywhere, a re-export from pg of its Pool, its Client, its default or
//     all of it (`export *`, `export * as`), any re-export from pg-pool, and
//     pg imported whole put to any use but a way in (`pg.types`, `pg[key]`,
//     `pg.ClientBase` in a type), since `export default pg` or `const db =
//     pg` hands it on;
//   - a property called `types` or `binary` given to anything, as a member of
//     an object or a class (property, shorthand, method, getter, or a
//     constructor's parameter property), or reached through `.binary`, or
//     through `.types` other than to read on into it (`pg.types.builtins`),
//     which is how every assignment to one is written. `types: [...]`, an
//     array literal under a plain name, is a Parse message's parameter type
//     ids. db/pgTypes.ts reads `binary`: it is the check;
//   - `setTypeParser`, outside db/pgTypes.ts, and `parseInt8`, anywhere.
// Each name counts written as an identifier in those places, and as a string
// or template literal anywhere: `pg["Pool"]`, `{ ["types"]: t }`,
// `Reflect.set(o, "binary", 1)`. It reads syntax, so a spelling not listed
// here is beyond it: a name assembled at runtime (`"Po" + "ol"`, a variable),
// or an object built at runtime or spread in from outside src/. What db/pool.ts
// itself exports is pinned by a test above. The tripwire refuses the
// Pool-level ones in production whatever their spelling; this refuses them at
// commit time, and nothing else refuses the rest.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONSTRUCTORS = new Set(["Pool", "Client"]);

function driverEscapes(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = (node: ts.Node): string => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  // A name written as an identifier. One written as a string or template
  // literal is read where that literal is visited, wherever it stands.
  const identifier = (node: ts.Node | undefined): string | undefined => (node !== undefined && ts.isIdentifier(node) ? node.text : undefined);
  const found: string[] = [];
  const flag = (name: string, node: ts.Node): void => {
    if (CONSTRUCTORS.has(name) && file !== "db/pool.ts") found.push(`${at(node)} reaches for pg's ${name}`);
    if (name === "types") found.push(`${at(node)} brings its own parsers`);
    if (name === "binary" && file !== "db/pgTypes.ts") found.push(`${at(node)} asks for binary results`);
    if (name === "setTypeParser" && file !== "db/pgTypes.ts") found.push(`${at(node)} replaces a parser`);
    if (name === "parseInt8") found.push(`${at(node)} touches pg.defaults.parseInt8`);
  };
  // The names this file gives pg imported whole: `import pg from "pg"`,
  // `import * as pgx from "pg"`, `import { default as pgAll } from "pg"`.
  const wholePg = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (statement.moduleSpecifier.text !== "pg" || clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined) wholePg.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) wholePg.add(bindings.name.text);
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly && identifier(element.propertyName) === "default") wholePg.add(element.name.text);
      }
    }
  }
  const visit = (node: ts.Node): void => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : undefined;
    const from = specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : undefined;
    // Re-exports hand pg on to files that never name it.
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const clause = node.exportClause;
      if (from === "pg-pool") found.push(`${at(node)} re-exports pg-pool`);
      if (from === "pg" && (clause === undefined || ts.isNamespaceExport(clause))) found.push(`${at(node)} re-exports all of pg`);
      if (from === "pg" && clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const exported = identifier(element.propertyName ?? element.name);
          if (element.isTypeOnly || exported === undefined) continue;
          if (CONSTRUCTORS.has(exported)) found.push(`${at(element)} re-exports pg's ${exported}`);
          if (exported === "default") found.push(`${at(element)} re-exports all of pg`);
        }
      }
    }
    // Type positions (`pg.Pool` in an annotation, `import type`) are not values.
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true && file !== "db/pool.ts") {
      if (from === "pg-pool") found.push(`${at(node)} imports pg-pool`);
      const named = node.importClause?.namedBindings;
      if (from === "pg" && named !== undefined && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const imported = identifier(element.propertyName ?? element.name);
          if (!element.isTypeOnly && imported !== undefined && CONSTRUCTORS.has(imported)) found.push(`${at(element)} imports pg's ${imported}`);
        }
      }
    }
    // A TypeScript import alias names its target as a qualified name rather
    // than a property: `import P = pgx.Pool` (a cold review's round 6).
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isQualifiedName(node.moduleReference)) {
      flag(node.moduleReference.right.text, node);
    }
    // pg imported whole, used as anything but a way in, is pg handed on.
    if (ts.isIdentifier(node) && wholePg.has(node.text)) {
      const parent = node.parent;
      const declares = ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportSpecifier(parent);
      const wayIn =
        ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) ||
        (ts.isQualifiedName(parent) && parent.left === node);
      if (!declares && !wayIn) found.push(`${at(node)} hands on all of pg`);
    }
    if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      // `constructor(readonly types = t)` declares a property too (round 6).
      (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent))
    ) {
      const name = identifier(node.name);
      const typeIds = ts.isPropertyAssignment(node) && ts.isArrayLiteralExpression(node.initializer);
      if ((name === "types" && !typeIds) || name === "binary") flag(name, node);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      const readOn = (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node;
      if (CONSTRUCTORS.has(name) || name === "binary" || (name === "types" && !readOn)) flag(name, node);
    }
    if (ts.isBindingElement(node)) {
      const name = identifier(node.propertyName ?? node.name);
      if (name !== undefined && CONSTRUCTORS.has(name)) flag(name, node);
    }
    if (ts.isStringLiteralLike(node)) flag(node.text, node);
    if (ts.isIdentifier(node) && (node.text === "setTypeParser" || node.text === "parseInt8")) flag(node.text, node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  // One spelling can meet two rules: `({ binary: pg.defaults.binary } = o)` is
  // a member and a property. Report it once.
  return [...new Set(found)];
}

test("THE ONLY POOL: no other file reaches or re-exports pg's Pool or Client, brings its own parsers or binary results, registers a parser, or touches parseInt8", () => {
  const files = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => name.split(path.sep).join("/"));
  // A walk that saw nothing would pass. These are the files that matter most.
  for (const file of ["db/pool.ts", "db/pgTypes.ts", "index.ts", "routes/segments.ts", "routes/sessions.ts", "scripts/findHoles.ts"]) {
    assert.ok(files.includes(file), `the walk never reached ${file}`);
  }
  const found = files.flatMap((file) => driverEscapes(file, readFileSync(path.join(SRC, file), "utf8")));
  assert.deepEqual(found, []);
});

test("...and that check finds each escape when one is there", () => {
  const escapes = (text: string, file = "scripts/x.ts") => driverEscapes(file, text);
  // A second Pool or Client, under every spelling a cold review tried.
  assert.deepEqual(escapes(`import pg from "pg";\nexport const p = new pg.Pool({});`), ["scripts/x.ts:2 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`import { Client } from "pg";\nnew Client();`), ["scripts/x.ts:1 imports pg's Client"]);
  assert.deepEqual(escapes(`import { Pool as DbPool } from "pg";\nnew DbPool();`), ["scripts/x.ts:1 imports pg's Pool"]);
  assert.deepEqual(escapes(`new (pg.Pool)({});`), ["scripts/x.ts:1 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`new pg["Pool"]({});`), ["scripts/x.ts:1 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`new pg[("Client")]({});`), ["scripts/x.ts:1 reaches for pg's Client"]);
  assert.deepEqual(escapes(`const P = pg.Pool;`), ["scripts/x.ts:1 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`const { Pool: P } = pg;`), ["scripts/x.ts:1 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`const { ["Pool"]: P } = pg;`), ["scripts/x.ts:1 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`const P = Reflect.get(pg, "Pool");`), ["scripts/x.ts:1 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`import PgPool from "pg-pool";`), ["scripts/x.ts:1 imports pg-pool"]);
  // ...or handed on under another module's name (cold reviews' rounds 4 and 5).
  assert.deepEqual(escapes(`export { Pool } from "pg";`), ["scripts/x.ts:1 re-exports pg's Pool"]);
  assert.deepEqual(escapes(`export { Client as C } from "pg";`), ["scripts/x.ts:1 re-exports pg's Client"]);
  assert.deepEqual(escapes(`export * from "pg";`), ["scripts/x.ts:1 re-exports all of pg"]);
  assert.deepEqual(escapes(`export * as pgx from "pg";`), ["scripts/x.ts:1 re-exports all of pg"]);
  assert.deepEqual(escapes(`export { default as pgx } from "pg";`), ["scripts/x.ts:1 re-exports all of pg"]);
  assert.deepEqual(escapes(`export * from "pg-pool";`), ["scripts/x.ts:1 re-exports pg-pool"]);
  // ...aliased, or pg handed on whole (a cold review's round 6).
  assert.deepEqual(escapes(`import * as pgx from "pg";\nimport P = pgx.Pool;`), ["scripts/x.ts:2 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`export import C = pgx.Client;`), ["scripts/x.ts:1 reaches for pg's Client"]);
  assert.deepEqual(escapes(`import pg from "pg";\nexport default pg;`), ["scripts/x.ts:2 hands on all of pg"]);
  assert.deepEqual(escapes(`import * as pgx from "pg";\nexport { pgx };`), ["scripts/x.ts:2 hands on all of pg"]);
  assert.deepEqual(escapes(`import { default as pgAll } from "pg";\nexport const db = pgAll;`), ["scripts/x.ts:2 hands on all of pg"]);
  // Parsers of its own, or binary results, given to anything: as a member of
  // any kind, through a property by any assignment, or under a literal name.
  assert.deepEqual(escapes(`pool.query({ text: "select 1", types: { getTypeParser } });`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`pool.query({ ["types"]: rounding, text: "select 1" });`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`const config = { text: "select 1", types };\npool.query(config);`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`const config = { text: "select 1", get types() { return custom; } };`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`class Config { text = "select 1"; binary = true; }`), ["scripts/x.ts:1 asks for binary results"]);
  assert.deepEqual(escapes(`const config = { text: "select 1", binary() { return 1; } };`), ["scripts/x.ts:1 asks for binary results"]);
  assert.deepEqual(escapes(`class Parsed { constructor(readonly types = rounding) {} }`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`class Config { constructor(public binary = true) {} }`), ["scripts/x.ts:1 asks for binary results"]);
  assert.deepEqual(escapes(`export const pool = new Pool({ connectionString, types: custom });`, "db/pool.ts"), [
    "db/pool.ts:1 brings its own parsers",
  ]);
  assert.deepEqual(escapes(`pool.options.types = { getTypeParser };`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`pool.options.types ??= custom;`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`Object.assign(pool.options, { types: custom });`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`Object.defineProperty(pool.options, "types", { value: custom });`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`pool.query({ text: "select 1", binary: true });`), ["scripts/x.ts:1 asks for binary results"]);
  assert.deepEqual(escapes(`pg.defaults.binary = true;`), ["scripts/x.ts:1 asks for binary results"]);
  assert.deepEqual(escapes(`(pool.options as { binary?: unknown }).binary ||= 1;`), ["scripts/x.ts:1 asks for binary results"]);
  assert.deepEqual(escapes(`[pg.defaults.binary] = [true];`), ["scripts/x.ts:1 asks for binary results"]);
  assert.deepEqual(escapes(`({ binary: pg.defaults.binary } = { binary: true });`), ["scripts/x.ts:1 asks for binary results"]);
  assert.deepEqual(escapes(`Reflect.set(pg.defaults, "binary", true);`), ["scripts/x.ts:1 asks for binary results"]);
  // `.types` counts unless it is read on into, even when used as a key.
  assert.deepEqual(escapes(`const parse = parsers[config.types];`), ["scripts/x.ts:1 brings its own parsers"]);
  // A parser replaced, or pg's switch, as an identifier or a literal.
  assert.deepEqual(escapes(`pg.types.setTypeParser(20, (t) => parseInt(t, 10));`), ["scripts/x.ts:1 replaces a parser"]);
  assert.deepEqual(escapes(`pg.types["setTypeParser"](20, Number);`), ["scripts/x.ts:1 replaces a parser"]);
  assert.deepEqual(escapes(`pg.defaults.parseInt8 = true;`), ["scripts/x.ts:1 touches pg.defaults.parseInt8"]);
  assert.deepEqual(escapes(`pg.defaults["parseInt8"] = false;`), ["scripts/x.ts:1 touches pg.defaults.parseInt8"]);
  assert.deepEqual(escapes(`Object.assign(pg.defaults, { parseInt8: true });`), ["scripts/x.ts:1 touches pg.defaults.parseInt8"]);
  // Not escapes: the two files whose job these are, types, reading on into
  // pg's registry or a union's members, and the census's Parse message, whose
  // `types` lists parameter type ids rather than parsers.
  assert.deepEqual(escapes(`import { Pool } from "pg";\nexport const pool = new Pool({});`, "db/pool.ts"), []);
  assert.deepEqual(escapes(`import pg from "pg";\nexport const pool = new pg.Pool({});`, "db/pool.ts"), []);
  assert.deepEqual(escapes(`pg.types.setTypeParser(20, parse);\nif ((client as { binary?: unknown }).binary) refuse();`, "db/pgTypes.ts"), []);
  assert.deepEqual(escapes(`import type { Pool, PoolClient } from "pg";\nlet db: pg.Pool;\ntype C = typeof pg.Client;`), []);
  assert.deepEqual(escapes(`import { type Pool } from "pg";`), []);
  assert.deepEqual(escapes(`export type { Pool } from "pg";\nexport { type Client } from "pg";`), []);
  assert.deepEqual(escapes(`const INT8 = pg.types.builtins.INT8;\nconst text = union.types.every(isText);\nconst named = pg.types[name];`), []);
  assert.deepEqual(escapes(`import pg from "pg";\nconst parse = pg.types.getTypeParser(20);\nconst entry = pg[key];\nlet client: pg.ClientBase;`), []);
  assert.deepEqual(escapes(`connection.parse({ name: "", text: "select 1", types: [] }, false);`), []);
});
