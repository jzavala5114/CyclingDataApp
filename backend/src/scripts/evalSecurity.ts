// npm run eval:security
//
// Whether Supabase's public API roles (`anon`, `authenticated`) can reach
// anything of ours in the database DATABASE_URL names: row level security on
// every table of ours, no privilege for either role on any table, view or
// sequence of ours, nothing for them in the default privileges of the role
// that owns our tables, and Supabase's own advisor rules (splinter/) flagging
// nothing of ours. securityChecks.ts holds the checks; the migration that
// makes them pass is src/db/migrations/004_row_level_security.sql.
//
// Reads only: one transaction, BEGIN TRANSACTION READ ONLY, then ROLLBACK, over
// TLS. Prints each check and what is not ours to change (PostGIS's tables,
// views and functions in public). Exits 1 if any check fails.
import "dotenv/config";
import fs from "node:fs";
import { encryptOwnConnection } from "./backupFormat.js";
import { securityChecks, securityNotes, securityReport } from "./securityChecks.js";

const SCHEMA_SQL = new URL("../db/schema.sql", import.meta.url);

async function main(): Promise<boolean> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (backend/.env)");
  // Every libpq setting from the shell dropped, and TLS asked for.
  encryptOwnConnection(process.env);
  const { pool } = await import("../db/pool.js");
  const client = await pool.connect();
  try {
    const host = new URL(process.env.DATABASE_URL).hostname;
    await client.query("begin transaction read only");
    const report = await securityReport(client, fs.readFileSync(SCHEMA_SQL, "utf8"));
    console.log(`eval:security, read-only, against ${host} (PostgreSQL ${report.server}, TLS ${client.ssl ? "on" : "OFF"})\n`);
    const checks = securityChecks(report);
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : `\n      ${c.detail.split("\n").join("\n      ")}`}`);
    for (const note of securityNotes(report)) console.log(`\nnote  ${note}`);
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${checks.length - failed} of ${checks.length} checks passed`);
    return failed === 0;
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
