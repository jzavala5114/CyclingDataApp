import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveMigration } from "./migrate.js";

// `migrate --apply` runs arbitrary DDL against the live database, so the only
// part worth a gate test is the part that decides which file that is.

test("a migration in the migrations directory resolves", () => {
  const full = resolveMigration("src/db/migrations/002_segment_is_tunnel.sql");
  assert.equal(path.basename(full), "002_segment_is_tunnel.sql");
  assert.ok(path.isAbsolute(full));
});

test("the same file resolves whether it is given relative or absolute", () => {
  const rel = resolveMigration("src/db/migrations/001_elevation_source.sql");
  const abs = resolveMigration(path.resolve("src/db/migrations/001_elevation_source.sql"));
  assert.equal(rel, abs);
});

test("schema.sql is refused", () => {
  // THE ONE THAT MATTERS. schema.sql is a fresh-install script: bare `create
  // table segments (...)` and the rest. Against a database holding rides it
  // fails on the first statement, and against an empty one it would be the
  // right thing to run -- but never through here, where it sits one directory
  // up from the migrations and is an easy tab-completion away.
  assert.throws(() => resolveMigration("src/db/schema.sql"), /not inside/);
});

test("a path climbing out of the migrations directory is refused", () => {
  assert.throws(() => resolveMigration("src/db/migrations/../schema.sql"), /not inside/);
  assert.throws(() => resolveMigration("../../../etc/passwd.sql"), /not inside/);
  assert.throws(() => resolveMigration("src/db"), /not inside/);
});

test("a non-sql file inside the directory is refused", () => {
  assert.throws(() => resolveMigration("src/db/migrations/README.md"), /not a .sql file/);
  assert.throws(() => resolveMigration("src/db/migrations"), /not a .sql file/);
});

test("no argument prints the usage rather than guessing a file", () => {
  assert.throws(() => resolveMigration(undefined), /usage:/);
  assert.throws(() => resolveMigration(""), /usage:/);
});
