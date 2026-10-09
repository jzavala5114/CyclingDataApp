import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import {
  ACCEPTED_OUTSIDE,
  DescribeStatement,
  censusCommand,
  findQuerySites,
  loadProgram,
  unreadModules,
} from "./evalQueryTypes.js";

// The census over the REAL program. Every test in evalQueryTypes.test.ts runs
// on fixtures, so cold reviews could point the census at tsconfig.json (which
// drops evalLinkerFold.ts), skip routes/ or scripts/, or drop what main()
// hands it for the code it cannot read, and nothing failed. Loading the program
// costs about a second, so it is loaded once, in a file of its own that runs
// in parallel with the rest. The driver does not matter here: nothing below
// parses a value.

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const real = loadProgram(backendDir);
const found = findQuerySites(real, backendDir);

test("THE REAL PROGRAM: every directory is searched, under the config that also sees evalLinkerFold.ts", () => {
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
  // through a declaration file: outside the census, so it must be accepted.
  assert.deepEqual(unreadModules(real, backendDir), ["../osm-pipeline/scripts/lib/linkPlan.d.mts"]);
});

test("THE COMMAND over the real program: every statement described, linkPlan accepted by hand, and nothing else fails it", { timeout: 15000 }, async () => {
  // A cold review deleted what main() passed for the code the census cannot
  // read, and every test passed. censusCommand holds that wiring now, and this
  // runs it as main() does. The database here answers every describe with no
  // columns, so no query can lie or be untyped: the wiring alone decides.
  let describes = 0;
  const client = {
    query: (arg: unknown) => {
      if (!(arg instanceof DescribeStatement)) return Promise.resolve({ rows: [] });
      describes++;
      queueMicrotask(() => arg.handleReadyForQuery());
      return arg;
    },
  } as unknown as pg.PoolClient;
  const printed: string[] = [];
  const before = process.exitCode;
  try {
    const census = await censusCommand(client, real, backendDir, (line) => printed.push(line));
    const statements = found.reduce((n, s) => n + s.statements.length, 0);
    assert.ok(statements > 50, `only ${statements} statements found in the real program`);
    assert.equal(describes, statements, "every statement the program sends was described");
    assert.deepEqual(census.outside.map((o) => o.module), Object.keys(ACCEPTED_OUTSIDE));
    assert.deepEqual([census.unacceptedOutside, census.acceptedGone, census.unchecked], [[], [], []]);
    assert.equal(census.pass, true, printed.join("\n"));
  } finally {
    process.exitCode = before;
  }
});
