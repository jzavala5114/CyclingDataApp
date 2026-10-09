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
await import("./pool.js");

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

// Everything above holds for a process only while its queries go through that
// Pool, with the parsers it leaves. A script that built its own Pool without
// importing pool.ts, a query that brought its own `types`, or a parser
// registered somewhere else would each give ids as text, or rounded, again,
// and the census could not notice: it judges every query with ITS OWN
// process's driver. A cold review built a second Pool in findHoles.ts and every
// test passed. So this reads every source file.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function driverEscapes(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lastName = (e: ts.Expression): string =>
    ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
  // pg's constructors, under whatever names this file imports them as.
  const constructors = new Set(["Pool", "Client"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || (statement.moduleSpecifier as ts.StringLiteral).text !== "pg") continue;
    const named = statement.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if (constructors.has((element.propertyName ?? element.name).text)) constructors.add(element.name.text);
    }
  }
  const property = (literal: ts.ObjectLiteralExpression, name: string) =>
    literal.properties.find((p) => p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
  // A config is an object handed to pg, or one shaped like a query's or a
  // connection's: built beforehand, it reaches pg all the same. A Parse
  // message's `types` is an array of parameter type ids, a different thing.
  const isConfig = (literal: ts.ObjectLiteralExpression): boolean => {
    const parent = literal.parent;
    const handed =
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      (parent.arguments ?? []).some((arg) => arg === literal) &&
      (/^(query|connect)$/.test(lastName(parent.expression)) || constructors.has(lastName(parent.expression)));
    return handed || property(literal, "text") !== undefined || property(literal, "connectionString") !== undefined;
  };
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const at = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    if (ts.isNewExpression(node) && constructors.has(lastName(node.expression)) && file !== "db/pool.ts") {
      found.push(`${at} builds a ${lastName(node.expression)}`);
    }
    if (ts.isObjectLiteralExpression(node) && isConfig(node)) {
      const types = property(node, "types");
      const parameterIds = types !== undefined && ts.isPropertyAssignment(types) && ts.isArrayLiteralExpression(types.initializer);
      if (types !== undefined && !parameterIds) found.push(`${at} brings its own parsers`);
    }
    if (ts.isCallExpression(node) && lastName(node.expression) === "setTypeParser" && file !== "db/pgTypes.ts") {
      found.push(`${at} replaces a parser`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("THE ONLY POOL: no other file builds a Pool or Client, brings its own parsers, or replaces one", () => {
  const found: string[] = [];
  for (const name of readdirSync(SRC, { recursive: true }) as string[]) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const file = name.split(path.sep).join("/");
    found.push(...driverEscapes(file, readFileSync(path.join(SRC, name), "utf8")));
  }
  assert.deepEqual(found, []);
});

test("...and that check finds each escape when one is there", () => {
  assert.deepEqual(driverEscapes("scripts/x.ts", `import pg from "pg";\nexport const p = new pg.Pool({});`), [
    "scripts/x.ts:2 builds a Pool",
  ]);
  assert.deepEqual(driverEscapes("scripts/x.ts", `import { Client } from "pg";\nnew Client();`), ["scripts/x.ts:2 builds a Client"]);
  assert.deepEqual(driverEscapes("scripts/x.ts", `pool.query({ text: "select 1", types: { getTypeParser } });`), [
    "scripts/x.ts:1 brings its own parsers",
  ]);
  assert.deepEqual(driverEscapes("scripts/x.ts", `pg.types.setTypeParser(20, (t) => parseInt(t, 10));`), [
    "scripts/x.ts:1 replaces a parser",
  ]);
  // Under another name, or with the config built before the call.
  assert.deepEqual(driverEscapes("scripts/x.ts", `import { Pool as DbPool } from "pg";\nnew DbPool();`), [
    "scripts/x.ts:2 builds a DbPool",
  ]);
  assert.deepEqual(driverEscapes("scripts/x.ts", `const config = { text: "select 1", types };\npool.query(config);`), [
    "scripts/x.ts:1 brings its own parsers",
  ]);
  assert.deepEqual(driverEscapes("db/pool.ts", `export const pool = new Pool({ connectionString, types: custom });`), [
    "db/pool.ts:1 brings its own parsers",
  ]);
  // The two files whose job these are, and the census's Parse message, whose
  // `types` lists parameter type ids rather than parsers.
  assert.deepEqual(driverEscapes("db/pool.ts", `export const pool = new Pool({});`), []);
  assert.deepEqual(driverEscapes("db/pgTypes.ts", `pg.types.setTypeParser(20, parse);`), []);
  assert.deepEqual(driverEscapes("scripts/x.ts", `connection.parse({ name: "", text: "select 1", types: [] }, false);`), []);
});
