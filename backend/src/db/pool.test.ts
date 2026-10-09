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
const { pool } = await import("./pool.js");
// Only now, so the observation above saw what pool.ts did and nothing else.
const { int8FromText, int8ArrayFromText } = await import("./pgTypes.js");

test("importing db/pool.ts is what makes a bigint arrive as a number", () => {
  assert.equal(before, "84", "nothing in this file configured the driver before pool.ts did");
  assert.equal(parserFor(20)("84"), 84);
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
  // client a checkout hands out is checked too, through pg's own lookup.
  const rounding = { getTypeParser: (oid: number, format?: string) => (oid === 20 ? Number : pg.types.getTypeParser(oid as TypeId, format as "text")) };
  for (const [what, config, reason] of [
    ["a Pool given its own types", { types: rounding }, /a checked-out client's int8 \(20\) parser is not the one db\/pgTypes\.ts installed/],
    ["a Pool set to binary", { binary: true }, /asks for binary results/],
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

// The tripwire guards the one Pool. A script that built a Pool of its own would
// never pass through it, and in a process that never loads pool.ts, ids are
// text again. The census cannot notice either: it judges every query with its
// own process's driver. A cold review built a second Pool in findHoles.ts and
// every test passed, and the next one reached pg's Pool through a re-export.
// So this reads every source file, for each way of reaching or re-exporting
// pg's constructors, of giving anything parsers of its own or binary results,
// of registering a parser, and the parseInt8 switch. The tripwire would refuse
// most of these in production; this refuses them at commit time.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONSTRUCTORS = new Set(["Pool", "Client"]);

function driverEscapes(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = (node: ts.Node): string => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const nameOf = (node: ts.Node | undefined): string | undefined =>
    node !== undefined && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
  // A property given a value, in an object literal or by assignment, whatever
  // object it lands on: a config built beforehand reaches pg all the same.
  const given = (node: ts.Node): { name: string | undefined; value: ts.Expression | undefined } | undefined => {
    if (ts.isPropertyAssignment(node)) return { name: nameOf(node.name), value: node.initializer };
    if (ts.isShorthandPropertyAssignment(node)) return { name: node.name.text, value: undefined };
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      if (ts.isPropertyAccessExpression(target)) return { name: target.name.text, value: node.right };
      if (ts.isElementAccessExpression(target)) return { name: nameOf(target.argumentExpression), value: node.right };
    }
    return undefined;
  };
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    // Re-exports hand pg's constructors to files that never name pg.
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const from = nameOf(node.moduleSpecifier);
      if (from === "pg-pool") found.push(`${at(node)} re-exports pg-pool`);
      const clause = node.exportClause;
      if (from === "pg" && clause === undefined) found.push(`${at(node)} re-exports all of pg`);
      if (from === "pg" && clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const exported = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && CONSTRUCTORS.has(exported)) found.push(`${at(element)} re-exports pg's ${exported}`);
        }
      }
    }
    // Parsers of its own, or binary results, given to anything. A Parse
    // message's `types` is an array of parameter type ids, a different thing.
    const property = given(node);
    if (property?.name === "types" && !(property.value !== undefined && ts.isArrayLiteralExpression(property.value))) {
      found.push(`${at(node)} brings its own parsers`);
    }
    if (property?.name === "binary") found.push(`${at(node)} asks for binary results`);
    if (file !== "db/pool.ts") {
      // Any value reference to pg's constructors, however it is spelled. Type
      // positions (`pg.Pool` in an annotation, `import type`) are not values.
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true) {
        const from = nameOf(node.moduleSpecifier);
        if (from === "pg-pool") found.push(`${at(node)} imports pg-pool`);
        const named = node.importClause?.namedBindings;
        if (from === "pg" && named !== undefined && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (!element.isTypeOnly && CONSTRUCTORS.has(imported)) found.push(`${at(element)} imports pg's ${imported}`);
          }
        }
      }
      const reached = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isElementAccessExpression(node)
          ? nameOf(node.argumentExpression)
          : ts.isBindingElement(node)
            ? nameOf(node.propertyName ?? node.name)
            : undefined;
      if (reached !== undefined && CONSTRUCTORS.has(reached)) found.push(`${at(node)} reaches for pg's ${reached}`);
    }
    const word = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (word === "setTypeParser" && file !== "db/pgTypes.ts") found.push(`${at(node)} replaces a parser`);
    if (word === "parseInt8") found.push(`${at(node)} touches pg.defaults.parseInt8`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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
  assert.deepEqual(escapes(`const P = pg.Pool;`), ["scripts/x.ts:1 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`const { Pool: P } = pg;`), ["scripts/x.ts:1 reaches for pg's Pool"]);
  assert.deepEqual(escapes(`import PgPool from "pg-pool";`), ["scripts/x.ts:1 imports pg-pool"]);
  // ...or handed on under another module's name (a cold review's round 4).
  assert.deepEqual(escapes(`export { Pool } from "pg";`), ["scripts/x.ts:1 re-exports pg's Pool"]);
  assert.deepEqual(escapes(`export { Client as C } from "pg";`), ["scripts/x.ts:1 re-exports pg's Client"]);
  assert.deepEqual(escapes(`export * from "pg";`), ["scripts/x.ts:1 re-exports all of pg"]);
  assert.deepEqual(escapes(`export * from "pg-pool";`), ["scripts/x.ts:1 re-exports pg-pool"]);
  // Parsers of its own, or binary results, given however.
  assert.deepEqual(escapes(`pool.query({ text: "select 1", types: { getTypeParser } });`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`const config = { text: "select 1", types };\npool.query(config);`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`export const pool = new Pool({ connectionString, types: custom });`, "db/pool.ts"), [
    "db/pool.ts:1 brings its own parsers",
  ]);
  assert.deepEqual(escapes(`pool.options.types = { getTypeParser };`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`Object.assign(pool.options, { types: custom });`), ["scripts/x.ts:1 brings its own parsers"]);
  assert.deepEqual(escapes(`pool.query({ text: "select 1", binary: true });`), ["scripts/x.ts:1 asks for binary results"]);
  assert.deepEqual(escapes(`pg.defaults.binary = true;`), ["scripts/x.ts:1 asks for binary results"]);
  // A parser replaced, or pg's switch, however spelled.
  assert.deepEqual(escapes(`pg.types.setTypeParser(20, (t) => parseInt(t, 10));`), ["scripts/x.ts:1 replaces a parser"]);
  assert.deepEqual(escapes(`pg.types["setTypeParser"](20, Number);`), ["scripts/x.ts:1 replaces a parser"]);
  assert.deepEqual(escapes(`pg.defaults.parseInt8 = true;`), ["scripts/x.ts:1 touches pg.defaults.parseInt8"]);
  assert.deepEqual(escapes(`pg.defaults["parseInt8"] = false;`), ["scripts/x.ts:1 touches pg.defaults.parseInt8"]);
  assert.deepEqual(escapes(`Object.assign(pg.defaults, { parseInt8: true });`), ["scripts/x.ts:1 touches pg.defaults.parseInt8"]);
  // Not escapes: the two files whose job these are, types, and the census's
  // Parse message, whose `types` lists parameter type ids rather than parsers.
  assert.deepEqual(escapes(`import { Pool } from "pg";\nexport const pool = new Pool({});`, "db/pool.ts"), []);
  assert.deepEqual(escapes(`pg.types.setTypeParser(20, parse);`, "db/pgTypes.ts"), []);
  assert.deepEqual(escapes(`import type { Pool, PoolClient } from "pg";\nlet db: pg.Pool;\ntype C = typeof pg.Client;`), []);
  assert.deepEqual(escapes(`import { type Pool } from "pg";`), []);
  assert.deepEqual(escapes(`export type { Pool } from "pg";\nexport { type Client } from "pg";`), []);
  assert.deepEqual(escapes(`connection.parse({ name: "", text: "select 1", types: [] }, false);`), []);
});
