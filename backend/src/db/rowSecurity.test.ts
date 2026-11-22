import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createdTables,
  grantsToOpeners,
  isUndo,
  migrationNumber,
  rowSecurityGaps,
  rowSecurityTables,
  withoutBlockComments,
  type SqlFile,
} from "./rowSecurity.js";

// Supabase's public API roles must never reach a row of ours: every table the
// scripts create has row level security on, nothing grants those roles
// anything, and every function we create is closed to PUBLIC
// (migrations/004 says why). These hold the real schema.sql and migrations to
// that, so a slip fails here, at commit, before it reaches the live database.

const DB = new URL("./", import.meta.url);
const schema = fs.readFileSync(fileURLToPath(new URL("schema.sql", DB)), "utf8");
const migrationsDir = new URL("migrations/", DB);
const migrations: SqlFile[] = fs
  .readdirSync(fileURLToPath(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .map((name) => ({ name, sql: fs.readFileSync(fileURLToPath(new URL(name, migrationsDir)), "utf8") }));
const migration004 = migrations.find((m) => m.name === "004_row_level_security.sql")!;

const APP_TABLES = [
  "segment_coverage",
  "segment_dem_elevations",
  "segment_elevation_buckets",
  "segment_pass_buckets",
  "segments",
  "session_samples",
  "session_segment_matches",
  "sessions",
];

// A later table, in schema.sql as a new database would have it.
const schemaWith = schema + "\ncreate table rides_shared (id bigint primary key);\nalter table rides_shared enable row level security;\n";
const with005 = (sql: string, name = "005_rides_shared.sql") => [...migrations, { name, sql }];

test("schema.sql and the migrations leave nothing of ours open", () => {
  assert.deepEqual(rowSecurityGaps(schema, migrations), []);
});

test("the real files are read, not passed by an empty reading", () => {
  // A parser that found nothing would report no gaps too.
  assert.deepEqual(createdTables(schema), APP_TABLES);
  assert.deepEqual(rowSecurityTables(schema), APP_TABLES);
  assert.deepEqual(rowSecurityTables(migration004.sql), APP_TABLES);
  assert.deepEqual(createdTables(migrations.find((m) => m.name === "003_pass_buckets.sql")!.sql), ["segment_pass_buckets"]);
  // The undo grants to anon and authenticated, which is what makes it an undo.
  assert.equal(grantsToOpeners(migrations.find((m) => isUndo(m.name))!.sql).length, 5);
});

test("a table schema.sql creates without its line is a gap, for each of the eight", () => {
  for (const table of APP_TABLES) {
    const line = new RegExp(`^alter table ${table} enable row level security;\\r?$`, "m");
    assert.match(schema, line, `schema.sql has ${table}'s line`);
    const gaps = rowSecurityGaps(schema.replace(line, ""), migrations);
    assert.ok(gaps.includes(`schema.sql creates ${table} without enabling its row level security`), `${table}: ${gaps.join("; ")}`);
  }
});

test("a table 004 leaves out is a gap: nothing else enables the eight on the live database", () => {
  for (const table of APP_TABLES) {
    const line = new RegExp(`^\\s*alter table public\\.${table} +enable row level security;\\r?$`, "m");
    assert.match(migration004.sql, line, `004 has ${table}'s line`);
    const without = migrations.map((m) => (m === migration004 ? { ...m, sql: m.sql.replace(line, "") } : m));
    const gaps = rowSecurityGaps(schema, without);
    assert.ok(gaps.some((g) => g.startsWith(`${table}:`)), `${table}: ${gaps.join("; ")}`);
  }
});

test("a later migration creating a table must enable it, there or after", () => {
  assert.deepEqual(rowSecurityGaps(schemaWith, with005("create table rides_shared (id bigint primary key);\nalter table rides_shared enable row level security;\n")), []);
  assert.deepEqual(rowSecurityGaps(schemaWith, with005("create table if not exists rides_shared (id bigint primary key);\n")), [
    "rides_shared: created by 005_rides_shared.sql, and neither it nor a later migration enables its row level security",
  ]);
  // Enabled by a later one: fine.
  assert.deepEqual(
    rowSecurityGaps(schemaWith, [
      ...with005("create table rides_shared (id bigint primary key);\n"),
      { name: "006_close_rides_shared.sql", sql: 'alter table if exists public."rides_shared" enable row level security;\n' },
    ]),
    [],
  );
  // "Enabled" by an earlier one, which ran before the table existed: a gap.
  assert.deepEqual(
    rowSecurityGaps(schemaWith, [
      ...migrations.map((m) => (m === migration004 ? { ...m, sql: m.sql + "\nalter table rides_shared enable row level security;\n" } : m)),
      { name: "005_rides_shared.sql", sql: "create table rides_shared (id bigint primary key);\n" },
    ]),
    ["rides_shared: created by 005_rides_shared.sql, and neither it nor a later migration enables its row level security"],
  );
});

test("a table a later migration drops and re-creates must be enabled again (the cold review's C1)", () => {
  const recreate =
    "drop table if exists segment_pass_buckets;\n" +
    "create table segment_pass_buckets (\n    match_id bigint not null,\n    bucket integer not null,\n    primary key (match_id, bucket)\n);\n";
  assert.deepEqual(rowSecurityGaps(schema, with005(recreate, "005_pass_buckets_by_index.sql")), [
    "segment_pass_buckets: created by 005_pass_buckets_by_index.sql, and neither it nor a later migration enables its row level security",
  ]);
  assert.deepEqual(rowSecurityGaps(schema, with005(recreate + "alter table segment_pass_buckets enable row level security;\n", "005_pass_buckets_by_index.sql")), []);
  // Enabled before the drop in the same file: still a gap, since the new table starts without it.
  assert.equal(
    rowSecurityGaps(schema, with005("alter table segment_pass_buckets enable row level security;\n" + recreate, "005_pass_buckets_by_index.sql")).length,
    1,
  );
});

test("a later migration switching a table's row level security off is a gap until one switches it on (C3)", () => {
  assert.deepEqual(rowSecurityGaps(schema, with005("alter table sessions disable row level security;\n", "005_open.sql")), [
    "sessions: 005_open.sql disables its row level security, and no later migration enables it again",
  ]);
  assert.deepEqual(
    rowSecurityGaps(schema, [
      ...with005("alter table sessions disable row level security;\n", "005_open.sql"),
      { name: "006_close.sql", sql: "alter table sessions enable row level security;\n" },
    ]),
    [],
  );
  assert.deepEqual(rowSecurityGaps(schema.replace(/^alter table sessions enable row level security;\r?$/m, "$&\nalter table sessions disable row level security;"), migrations), [
    "schema.sql disables sessions's row level security",
  ]);
});

test("a comment is not a statement, a line comment or a block one (C2)", () => {
  const lineComment = "create table rides_shared (id bigint primary key);\n-- alter table rides_shared enable row level security;\n";
  const blockComment = "create table rides_shared (id bigint primary key);\n/* enable once shares ship\nalter table rides_shared enable row level security;\n*/\n";
  for (const sql of [lineComment, blockComment]) {
    assert.deepEqual(rowSecurityTables(sql), []);
    assert.equal(rowSecurityGaps(schemaWith, with005(sql)).length, 1, sql);
  }
  assert.equal(withoutBlockComments("a /* b\nc */ d").split("\n").length, 2, "line breaks kept");
});

test("nothing grants to anon, authenticated or PUBLIC (C3)", () => {
  for (const sql of [
    "grant select on sessions to anon;",
    "grant select, insert on public.session_samples to authenticated, service_role;",
    "grant select on all tables in schema public to public;",
    "  grant usage on sequence sessions_id_seq to anon with grant option;",
    "alter default privileges for role postgres in schema public grant select on tables to anon;",
    "grant postgres to anon;",
  ]) {
    const gaps = rowSecurityGaps(schema, with005(sql, "005_grant.sql"));
    assert.equal(gaps.length, 1, `${sql}: ${gaps.join("; ")}`);
    assert.match(gaps[0]!, /^005_grant\.sql grants to the API's roles or PUBLIC: /);
  }
  for (const sql of [
    "grant select on sessions to service_role;",
    "grant anon to postgres;",
    "grant usage on schema public to postgres;",
    "revoke select on photos from anon;",
    "-- grant select on sessions to anon;",
    "/* grant select on sessions to anon; */",
  ]) {
    assert.deepEqual(rowSecurityGaps(schema, with005(sql, "005_fine.sql")), [], sql);
  }
  assert.equal(rowSecurityGaps(schema + "\ngrant select on sessions to anon;\n", migrations).length, 1, "in schema.sql too");
});

test("a function we create must have EXECUTE revoked from PUBLIC after it", () => {
  const create = "create or replace function public.recent_fixes() returns setof session_samples language sql security definer as 'select * from session_samples';\n";
  assert.deepEqual(rowSecurityGaps(schema, with005(create, "005_rpc.sql")), [
    "recent_fixes: created by 005_rpc.sql, and EXECUTE is not revoked from PUBLIC after it",
  ]);
  for (const close of [
    "revoke execute on function public.recent_fixes() from public;\n",
    "revoke all on function recent_fixes() from public, anon, authenticated cascade;\n",
    "revoke execute on all functions in schema public from public;\n",
  ]) {
    assert.deepEqual(rowSecurityGaps(schema, with005(create + close, "005_rpc.sql")), [], close);
    assert.deepEqual(rowSecurityGaps(schema, [...with005(create, "005_rpc.sql"), { name: "006_close.sql", sql: close }]), [], `later: ${close}`);
  }
  // Taken from the API's roles but not from PUBLIC, or before the function exists: still open.
  assert.equal(rowSecurityGaps(schema, with005(create + "revoke execute on function recent_fixes() from anon, authenticated;\n", "005_rpc.sql")).length, 1);
  assert.equal(rowSecurityGaps(schema, with005("revoke execute on all functions in schema public from public;\n" + create, "005_rpc.sql")).length, 1);
  assert.equal(rowSecurityGaps(schema + "\n" + create, migrations).length, 1, "in schema.sql too");
});

test("a migration's table missing from schema.sql is a gap: a new database would lack it", () => {
  const sql = "create table rides_shared (id bigint primary key);\nalter table rides_shared enable row level security;\n";
  assert.deepEqual(rowSecurityGaps(schema, with005(sql)), ["005_rides_shared.sql creates rides_shared, which schema.sql does not"]);
});

test("schema.sql takes the API roles' default privileges away before its first table", () => {
  const block = /^do \$\$\r?\ndeclare\r?\n  api_role text;[\s\S]*?^end \$\$;\r?$/m;
  assert.match(schema, block);
  const moved = schema.replace(block, "") + "\n" + schema.match(block)![0] + "\n";
  assert.deepEqual(rowSecurityGaps(moved, migrations), ["schema.sql creates a table before it takes the API roles' default privileges away"]);
  assert.deepEqual(rowSecurityGaps(schema.replace(block, ""), migrations), ["schema.sql creates a table before it takes the API roles' default privileges away"]);
});

test("the undo is not a migration, and a migration needs its number", () => {
  assert.ok(isUndo("004_row_level_security_undo.sql"));
  assert.ok(!isUndo("004_row_level_security.sql"));
  assert.equal(migrationNumber("004_row_level_security.sql"), 4);
  assert.equal(migrationNumber("row_level_security.sql"), null);
  // An undo is skipped whole: its grants and switches are not read, and one without a number is not flagged.
  assert.deepEqual(rowSecurityGaps(schema, [...migrations, { name: "undo_everything_undo.sql", sql: "grant all on sessions to anon;" }]), []);
  assert.deepEqual(rowSecurityGaps(schema, [...migrations, { name: "close_more.sql", sql: "" }]), ["close_more.sql: a migration's name starts with its number"]);
});
