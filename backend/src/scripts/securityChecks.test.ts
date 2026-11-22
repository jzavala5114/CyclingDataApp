import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RULE_0008, RULE_0013, RULE_0023 } from "./splinter/rules.js";
import { RULE_FILES, ruleStatement } from "./splinter/ruleText.js";
import {
  ADVISOR,
  describeDefaults,
  describeExposures,
  securityChecks,
  securityNotes,
  tablePrivileges,
  type SecurityReport,
} from "./securityChecks.js";

// The parts of eval:security that need no database: how a report becomes
// checks. The checks' SQL runs for real in eval:security-migration, against a
// stand-in, where every one is seen failing before migration 004 and passing
// after it.

const closed: SecurityReport = {
  server: "17.6",
  missingTables: [],
  tables: 8,
  sequences: 4,
  owners: ["postgres"],
  rowSecurityOff: [],
  exposures: [],
  defaults: [],
  advisor: [
    { lint: "0013_rls_disabled_in_public", level: "ERROR", detail: "Table \\`public.spatial_ref_sys\\` is public, but RLS has not been enabled.", table: "spatial_ref_sys", ours: false },
    { lint: "0008_rls_enabled_no_policy", level: "INFO", detail: "Table `public.sessions` has RLS enabled, but no policies exist", table: "sessions", ours: true },
  ],
  extensionRelations: ["geography_columns", "geometry_columns", "spatial_ref_sys"],
};

const failing = (report: SecurityReport) => securityChecks(report).filter((c) => !c.ok).map((c) => c.name);

test("a closed database passes every check, PostGIS's table and the INFO rule notwithstanding", () => {
  assert.deepEqual(failing(closed), []);
  assert.equal(securityChecks(closed).length, 5);
});

test("a database without our tables fails, rather than passing with nothing to judge", () => {
  const empty = { ...closed, tables: 0, sequences: 0, owners: [], missingTables: ["segments", "sessions"], advisor: [] };
  const failed = failing(empty);
  assert.ok(failed[0]!.startsWith("the tables schema.sql creates are all here"), failed.join("; "));
  // No owner found, so no default privileges were read: that is not a pass either.
  assert.ok(failed.some((n) => n.includes("default privileges")), failed.join("; "));
});

test("each kind of opening fails its own check", () => {
  assert.deepEqual(failing({ ...closed, rowSecurityOff: ["sessions"] }), ["row level security is on for every table of ours"]);
  assert.deepEqual(failing({ ...closed, exposures: [{ name: "sessions_id_seq", kind: "sequence", role: "anon", privilege: "USAGE" }] }), [
    "anon and authenticated may do nothing to any table, view, sequence or function of ours",
  ]);
  assert.deepEqual(failing({ ...closed, defaults: [{ creator: "postgres", schema: "public", objects: "tables", grantee: "PUBLIC", privilege: "SELECT" }] }), [
    "the default privileges of postgres give anon and authenticated no grant on later tables, sequences or functions (PostgreSQL's own PUBLIC EXECUTE on a new function is caught per function, above)",
  ]);
  const ours = { lint: "0023_sensitive_columns_exposed", level: "ERROR", detail: "Table `public.session_samples` ...", table: "session_samples", ours: true };
  assert.deepEqual(failing({ ...closed, advisor: [...closed.advisor, ours] }), ["Supabase's advisor (0013, 0023) flags nothing of ours"]);
});

test("the advisor's INFO rule is reported, never failed", () => {
  const noPolicy = closed.advisor.filter((f) => f.lint.startsWith("0008"));
  assert.deepEqual(failing({ ...closed, advisor: [...noPolicy, ...noPolicy] }), []);
  assert.match(securityNotes(closed).join("\n"), /advisor 0008 \(INFO\).*: 1 \(sessions\)/);
  assert.match(securityNotes(closed).join("\n"), /not ours: an extension owns geography_columns, geometry_columns, spatial_ref_sys in public; the advisor flags spatial_ref_sys/);
});

test("exposures and defaults read one line per object and role", () => {
  assert.deepEqual(
    describeExposures([
      { name: "sessions", kind: "table", role: "anon", privilege: "SELECT" },
      { name: "sessions", kind: "table", role: "anon", privilege: "TRUNCATE" },
      { name: "sessions", kind: "table", role: "authenticated", privilege: "SELECT" },
      { name: "sessions_id_seq", kind: "sequence", role: "anon", privilege: "USAGE" },
    ]),
    ["sessions (table): anon SELECT TRUNCATE; authenticated SELECT", "sessions_id_seq (sequence): anon USAGE"],
  );
  assert.deepEqual(
    describeDefaults([
      { creator: "postgres", schema: "public", objects: "tables", grantee: "anon", privilege: "SELECT" },
      { creator: "postgres", schema: "public", objects: "tables", grantee: "anon", privilege: "DELETE" },
    ]),
    ["postgres, in public, new tables: anon SELECT DELETE"],
  );
});

test("MAINTAIN is asked about from PostgreSQL 17, where it exists", () => {
  assert.ok(tablePrivileges(170006).includes("MAINTAIN"));
  assert.ok(!tablePrivileges(160004).includes("MAINTAIN"));
  assert.ok(tablePrivileges(160004).includes("TRUNCATE"));
});

test("rules.ts is the copied Supabase rules, each less its create view line, and their license is beside them", () => {
  // buildRules.ts writes rules.ts; a file updated without rerunning it, or a
  // constant edited by hand, fails here.
  const constants: Record<string, string> = { RULE_0008, RULE_0013, RULE_0023 };
  for (const { file, constant } of RULE_FILES) {
    const sql = fs.readFileSync(new URL(`./splinter/${file}`, import.meta.url), "utf8");
    assert.match(sql, /^create view lint\."\d{4}_\w+" as\r?\n/, file);
    assert.equal(constants[constant], ruleStatement(file, sql), `${constant}: rerun npx tsx src/scripts/splinter/buildRules.ts`);
    // As Git on Windows checks the file out, and as it is committed.
    assert.equal(constants[constant], ruleStatement(file, sql.replace(/\r?\n/g, "\r\n")), `${constant}, CRLF`);
    assert.equal(constants[constant], ruleStatement(file, sql.replace(/\r\n/g, "\n")), `${constant}, LF`);
    assert.doesNotMatch(constants[constant]!, /create view/i, constant);
  }
  assert.deepEqual(ADVISOR.map((r) => [r.lint, r.gate]), [
    ["0013_rls_disabled_in_public", true],
    ["0023_sensitive_columns_exposed", true],
    ["0008_rls_enabled_no_policy", false],
  ]);
  assert.match(fs.readFileSync(new URL("./splinter/LICENSE", import.meta.url), "utf8"), /The PostgreSQL License[\s\S]*Copyright \(c\) 2024, Supabase/);
  assert.throws(() => ruleStatement("x.sql", "select 1"), /not a splinter rule/);
});
