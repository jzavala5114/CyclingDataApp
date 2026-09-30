import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";

// Runs one migration file from src/db/migrations against DATABASE_URL.
//
// The migrations document `psql -f ...`, which is the right tool and is what
// runs them on a machine that has it. This exists because the dev machine here
// is Windows without psql, and the alternative was pasting DDL into an ad-hoc
// script every time -- which is how a migration ends up applied but not
// recorded in the repo.
//
// Prints the SQL and stops unless --apply is passed, the same shape as every
// other writing tool in this repo. DDL in Postgres is transactional, so the
// whole file lands or none of it does.
//
//   npm run migrate -- src/db/migrations/002_segment_is_tunnel.sql
//   npm run migrate -- src/db/migrations/002_segment_is_tunnel.sql --apply

// Relative to the working directory, not to this file: `npm run migrate` sets
// the cwd to backend/ either way, and resolving from import.meta.url would
// point at dist/db/migrations after a build, where tsc has copied no .sql.
const MIGRATIONS_DIR = path.resolve("src/db/migrations");

// Refuses a path outside the migrations directory. Not a security boundary --
// anyone who can run this can run psql -- but it catches the fat-finger that
// points this at schema.sql, which is a fresh-install script full of bare
// `create table` and would fail halfway through against a live database.
export function resolveMigration(arg: string | undefined): string {
  if (!arg) throw new Error("usage: npm run migrate -- <path/to/NNN_name.sql> [--apply]");
  const full = path.resolve(arg);
  const rel = path.relative(MIGRATIONS_DIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`refusing ${arg}: not inside ${MIGRATIONS_DIR}`);
  }
  if (!full.endsWith(".sql")) throw new Error(`refusing ${arg}: not a .sql file`);
  return full;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const file = resolveMigration(process.argv.slice(2).find((a) => !a.startsWith("--")));
  const sql = fs.readFileSync(file, "utf8");

  console.log(`--- ${path.relative(process.cwd(), file)} ---`);
  console.log(sql.trimEnd());
  console.log("---");

  if (!apply) {
    console.log("dry run -- nothing executed. Re-run with --apply.");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("commit");
    console.log("applied");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Only when run as the entry point, so the test can import `resolveMigration`
// without opening a connection to the live database.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
