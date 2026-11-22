// npm run eval:security-migration
//
// Proves src/db/migrations/004_row_level_security.sql, its undo and
// schema.sql's own row level security on a stand-in for the live database,
// before 004 goes near it. The stand-in is a throwaway PostgreSQL 17 with
// PostGIS (throwawayServer.ts), set up as Supabase sets up a project: its
// superuser is named supabase_admin and installs PostGIS; `postgres` owns the
// database and the app's tables, is no superuser and holds BYPASSRLS; `anon`,
// `authenticated` and `service_role` exist, and the default privileges of both
// supabase_admin and `postgres` give all three everything in public. Those are
// the facts read from production on 2026-11-22.
//
// In order: schema.sql on plain PostgreSQL, before those roles exist; then on
// the Supabase-like database; the undo, which must put back production's state
// before 004 grant for grant (FAITHFUL below), and be failed by every check,
// the way production was; 004 held off by a lock, and refusing a grant it
// cannot take back, under `npm run migrate` and plain `psql -f`, changing
// nothing each time; 004 for real, through `npm run migrate`, as `postgres`;
// a table and a function `postgres` makes after it; 004 again; the undo again,
// back to exactly the state before; 004 once more. At each step the checks of
// eval:security (securityChecks.ts) run, and `anon`, `authenticated`,
// `postgres` and `service_role` each try to read and write.
//
// Nothing here reaches production: it loads no .env, refuses to start with
// DATABASE_URL set, and gives `npm run migrate` and psql the stand-in's address
// (dotenv, which migrate.ts loads, never replaces a variable already set).
// About a minute and a half. Exits 1 if any check fails.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { childEnv, dropLibpqSettings, dumpArgs, exe, toolsDir } from "./backupFormat.js";
import { securityChecks, securityReport, type SecurityReport } from "./securityChecks.js";
import { run as runTool, startThrowaway } from "./throwawayServer.js";

const BACKEND = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATE = fileURLToPath(new URL("./migrate.ts", import.meta.url));
const SCHEMA_FILE = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
const SCHEMA = fs.readFileSync(SCHEMA_FILE, "utf8");
const MIGRATION = "src/db/migrations/004_row_level_security.sql";
const UNDO = "src/db/migrations/004_row_level_security_undo.sql";
/** How long any one migration may take before it is killed and counted as hung. */
const MIGRATE_LIMIT_MS = 120_000;

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
const APP_SEQUENCES = ["segments_id_seq", "session_samples_id_seq", "session_segment_matches_id_seq", "sessions_id_seq"];
const API = ["anon", "authenticated"];

// Production before 004, read 2026-11-22: every app table's relacl, every app
// sequence's, and postgres's default privileges in public for tables (r),
// sequences (S) and functions (f), each the same four grantees, all granted by
// postgres. Compared as sets: the order of a relacl's items is how they came.
const GRANTEES = ["postgres", "anon", "authenticated", "service_role"];
const all = (privileges: string) => GRANTEES.map((g) => `${g}=${privileges}/postgres`).sort().join(",");
const FAITHFUL = new Map<string, string>([
  ...APP_TABLES.map((t): [string, string] => [`relation ${t}`, `rls off; ${all("arwdDxtm")}`]),
  ...APP_SEQUENCES.map((s): [string, string] => [`relation ${s}`, `rls off; ${all("rwU")}`]),
  ["default r", all("arwdDxtm")],
  ["default S", all("rwU")],
  ["default f", all("X")],
]);

// The roles as production has them (2026-11-22): INHERIT on all, BYPASSRLS on
// postgres and service_role, postgres a member of the three API roles.
const SETUP = (password: string) => `
create role postgres login password '${password}' nosuperuser createdb createrole bypassrls inherit;
create role anon nologin inherit;
create role authenticated nologin inherit;
create role service_role nologin inherit bypassrls;
grant anon, authenticated, service_role to postgres;
alter database postgres owner to postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
create extension postgis;
alter default privileges for role postgres in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to postgres, anon, authenticated, service_role;
`;

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail.split("\n").join("\n      ")}`}`);
}

/** Runs `npm run migrate -- <file> --apply` as npm would, against `databaseUrl`: its exit code (null if killed at the limit), output and time. */
function migrate(file: string, databaseUrl: string): Promise<{ code: number | null; out: string; ms: number }> {
  if (!/@127\.0\.0\.1:\d+\//.test(databaseUrl)) throw new Error("the eval only ever migrates its stand-in");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", MIGRATE, file, "--apply"], {
      cwd: BACKEND,
      env: childEnv(process.env, { DATABASE_URL: databaseUrl }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    for (const stream of [child.stdout, child.stderr]) readline.createInterface({ input: stream, crlfDelay: Infinity }).on("line", (l) => lines.push(l));
    const timer = setTimeout(() => {
      lines.push(`(killed after ${MIGRATE_LIMIT_MS / 1000}s)`);
      child.kill();
    }, MIGRATE_LIMIT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: lines.join("\n"), ms: Date.now() - started });
    });
  });
}

const tail = (out: string, n = 8) => out.split("\n").slice(-n).join("\n");

async function main(): Promise<boolean> {
  if (process.env.DATABASE_URL !== undefined) throw new Error("DATABASE_URL is set: this eval builds its own database and never reads one from outside");
  dropLibpqSettings(process.env);
  const bin = toolsDir();
  const standIn = await startThrowaway({ bin, purpose: "eval", user: "supabase_admin" });
  try {
    console.log(`a stand-in for Supabase's database in ${standIn.work}, on 127.0.0.1:${standIn.port}\n`);
    const password = crypto.randomBytes(24).toString("base64url");
    const asPostgres = `postgresql://postgres:${password}@127.0.0.1:${standIn.port}/postgres?sslmode=disable`;
    const tool = (name: string) => path.join(bin, exe(name));
    /** psql against the stand-in, as `user`: its stdout; it rejects on a non-zero exit. */
    const psql = (user: "supabase_admin" | "postgres", database: string, args: string[]) =>
      runTool(
        tool("psql"),
        ["-X", "-q", "-h", "127.0.0.1", "-p", String(standIn.port), "-U", user, "-d", database, ...args],
        childEnv(process.env, { PGPASSWORD: user === "postgres" ? password : standIn.password, PGSSLMODE: "disable" }),
        120_000,
      );

    process.env.DATABASE_URL = standIn.url;
    const { pool } = await import("../db/pool.js");
    try {
      const identity = await pool.query<{ dir: string }>("select current_setting('data_directory') as dir");
      if (path.resolve(identity.rows[0]!.dir) !== path.resolve(standIn.data)) throw new Error("connected to a database that is not the stand-in");

      /** One transaction as `role`, committed. */
      const run = async (sql: string, role = "postgres") => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(`set local role ${role}`);
          await client.query(sql);
          await client.query("commit");
        } catch (err) {
          await client.query("rollback").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      };
      /** One statement as `role`, always rolled back: whether it was allowed, and the error's code if not. */
      const attempt = async (sql: string, role: string): Promise<string> => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(`set local role ${role}`);
          await client.query(sql);
          return "allowed";
        } catch (err) {
          return (err as { code?: string }).code === "42501" ? "refused" : `error ${(err as Error).message}`;
        } finally {
          await client.query("rollback").catch(() => undefined);
          client.release();
        }
      };
      const report = async (): Promise<SecurityReport> => {
        const client = await pool.connect();
        try {
          await client.query("begin transaction read only");
          return await securityReport(client, SCHEMA);
        } finally {
          await client.query("rollback").catch(() => undefined);
          client.release();
        }
      };
      // Every app relation's row level security and grants, and postgres's
      // default privileges in public, as comparable strings.
      const snapshot = async (): Promise<Map<string, string>> => {
        const { rows } = await pool.query<{ object: string; state: string; acl: string }>(
          `select 'relation ' || c.relname as object, case when c.relrowsecurity then 'rls on' else 'rls off' end as state, coalesce(c.relacl::text, '{}') as acl
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'S')
              and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
           union all
           select 'default ' || d.defaclobjtype::text, '', d.defaclacl::text
             from pg_default_acl d
            where d.defaclrole::regrole::text = 'postgres' and d.defaclnamespace::regnamespace::text = 'public'`,
        );
        const items = (acl: string) => acl.replace(/^\{|\}$/g, "").split(",").filter(Boolean).sort().join(",");
        return new Map(rows.map((r) => [r.object, r.state ? `${r.state}; ${items(r.acl)}` : items(r.acl)]));
      };
      const differences = (found: Map<string, string>, wanted: Map<string, string>) =>
        [...new Set([...found.keys(), ...wanted.keys()])]
          .sort()
          .filter((k) => found.get(k) !== wanted.get(k))
          .map((k) => `${k}: ${found.get(k) ?? "(absent)"}, wanted ${wanted.get(k) ?? "(absent)"}`);
      const failing = (r: SecurityReport) => securityChecks(r).filter((c) => !c.ok);
      const advisorTables = (r: SecurityReport, lint: string) => r.advisor.filter((f) => f.lint === lint).map((f) => f.table ?? "?").sort();

      // What each role may do. The API's roles try a read, a write, an update,
      // a delete and emptying a table, and a sequence; postgres does the
      // backend's kind of work; service_role reads.
      const behaviour = async () => {
        const refusedEverywhere: string[] = [];
        for (const role of API) {
          for (const table of APP_TABLES) {
            const result = await attempt(`select 1 from public.${table} limit 1`, role);
            if (result !== "refused") refusedEverywhere.push(`${role} select from ${table}: ${result}`);
          }
          for (const [what, sql] of [
            ["insert a ride", "insert into public.sessions (started_at) values (now())"],
            ["update a segment", "update public.segments set street_name = street_name"],
            ["delete coverage", "delete from public.segment_coverage"],
            ["empty segment_pass_buckets", "truncate public.segment_pass_buckets"],
            ["draw a fix number", "select nextval('public.session_samples_id_seq')"],
          ]) {
            const result = await attempt(sql!, role);
            if (result !== "refused") refusedEverywhere.push(`${role} ${what}: ${result}`);
          }
        }
        const backendNotAllowed: string[] = [];
        for (const [what, sql] of [
          [
            "save a ride and a fix",
            `with ride as (insert into public.sessions (started_at) values (now()) returning id),
                  fix as (insert into public.session_samples (session_id, recorded_at, lat, lon, elevation_m)
                          select id, now(), 38.8, -104.8, 1840 from ride returning id)
             select (select count(*) from fix) + (select count(*) from public.segment_elevation_buckets)`,
          ],
          ["update a ride", "update public.sessions set device_info = device_info"],
          ["delete coverage", "delete from public.segment_coverage"],
          ["empty a table", "truncate public.segment_coverage"],
        ]) {
          const result = await attempt(sql!, "postgres");
          if (result !== "allowed") backendNotAllowed.push(`postgres ${what}: ${result}`);
        }
        const service = await attempt("select count(*) from public.session_samples", "service_role");
        return { refusedEverywhere, backendNotAllowed, service };
      };

      // 0. schema.sql on plain PostgreSQL: before Supabase's roles exist.
      const rolesBefore = await pool.query<{ n: number }>("select count(*)::int as n from pg_roles where rolname in ('anon', 'authenticated')");
      await pool.query("create database plain");
      let plain: string;
      try {
        await psql("supabase_admin", "plain", ["-v", "ON_ERROR_STOP=1", "-f", SCHEMA_FILE]);
        plain = (
          await psql("supabase_admin", "plain", [
            "-At",
            "-c",
            "select count(*) filter (where c.relrowsecurity) || '/' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')",
          ])
        ).trim();
      } catch (err) {
        plain = `error: ${(err as Error).message}`;
      }
      check(
        "schema.sql on plain PostgreSQL, with no anon or authenticated role: it runs, and all eight tables have row level security",
        rolesBefore.rows[0]!.n === 0 && plain === "8/8",
        `roles anon/authenticated present: ${rolesBefore.rows[0]!.n}; ${plain}`,
      );

      await run(SETUP(password), "supabase_admin");
      const roles = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }>(
        "select rolname, rolsuper, rolbypassrls, rolinherit from pg_roles where rolname in ('postgres', 'supabase_admin', 'anon', 'authenticated', 'service_role') order by 1",
      );
      check(
        "the stand-in is set up as Supabase's: postgres no superuser and BYPASSRLS, supabase_admin the superuser, the API's three roles, all INHERIT",
        roles.rows.map((r) => `${r.rolname}:${r.rolsuper}:${r.rolbypassrls}:${r.rolinherit}`).join(" ") ===
          "anon:false:false:true authenticated:false:false:true postgres:false:true:true service_role:false:true:true supabase_admin:true:true:true",
        JSON.stringify(roles.rows),
      );

      // 1. schema.sql on a new Supabase-like database.
      await run(SCHEMA);
      const fresh = await report();
      check("schema.sql on a new database: every check of eval:security passes", failing(fresh).length === 0, failing(fresh).map((c) => `${c.name}: ${c.detail}`).join("\n"));
      check(
        "schema.sql on a new database: Supabase's advisor flags only PostGIS's spatial_ref_sys (0013) and nothing for 0023",
        advisorTables(fresh, "0013_rls_disabled_in_public").join() === "spatial_ref_sys" && advisorTables(fresh, "0023_sensitive_columns_exposed").length === 0,
        JSON.stringify(fresh.advisor.filter((f) => !f.lint.startsWith("0008"))),
      );
      const freshBehaviour = await behaviour();
      check(
        "schema.sql on a new database: anon and authenticated are refused every read and write; postgres reads, writes, deletes and empties a table",
        freshBehaviour.refusedEverywhere.length === 0 && freshBehaviour.backendNotAllowed.length === 0,
        [...freshBehaviour.refusedEverywhere, ...freshBehaviour.backendNotAllowed].join("\n"),
      );

      // 2. The undo: production as it is before 004.
      const undone = await migrate(UNDO, asPostgres);
      const legacy = await snapshot();
      check(
        "the undo puts back production's state before 004, grant for grant, flag for flag",
        undone.code === 0 && differences(legacy, FAITHFUL).length === 0,
        undone.code !== 0 ? tail(undone.out) : differences(legacy, FAITHFUL).join("\n"),
      );
      const before = await report();
      const failedBefore = failing(before).map((c) => c.name);
      check(
        "...and eval:security fails it the way it fails production: row level security, the API's grants, the defaults, the advisor",
        failedBefore.length === 4 &&
          before.rowSecurityOff.length === 8 &&
          before.exposures.length === 2 * (8 * 8 + 4 * 3) &&
          before.defaults.length === 2 * (8 + 3 + 1) &&
          advisorTables(before, "0013_rls_disabled_in_public").join() === [...APP_TABLES, "spatial_ref_sys"].sort().join() &&
          advisorTables(before, "0023_sensitive_columns_exposed").join() === "session_samples,session_segment_matches",
        `failed: ${failedBefore.join("; ")}; rls off ${before.rowSecurityOff.length}, exposures ${before.exposures.length}, defaults ${before.defaults.length}, advisor ${JSON.stringify(before.advisor.map((f) => `${f.lint}:${f.table}`))}`,
      );
      const open = await behaviour();
      check(
        "...and in it, anon reads, inserts a ride and empties a table, as anyone with the anon key could have",
        open.refusedEverywhere.some((r) => r.startsWith("anon select from sessions: allowed")) &&
          open.refusedEverywhere.includes("anon insert a ride: allowed") &&
          open.refusedEverywhere.includes("anon empty segment_pass_buckets: allowed"),
        open.refusedEverywhere.join("\n"),
      );

      // 3. 004 when it cannot finish, as it must behave on the live database.
      // A table held, as a backup's pg_dump holds every table: 004 gives up at
      // its lock timeout rather than queue the app's queries behind it.
      const holder = await pool.connect();
      let held: { code: number | null; out: string; ms: number };
      try {
        await holder.query("begin");
        await holder.query("lock table public.sessions in access share mode");
        held = await migrate(MIGRATION, asPostgres);
      } finally {
        await holder.query("rollback").catch(() => undefined);
        holder.release();
      }
      check(
        "004 gives up within its lock timeout while a table is held, as during a backup, and changes nothing",
        held.code === 1 && /lock timeout/i.test(held.out) && held.ms < 60_000 && differences(await snapshot(), legacy).length === 0,
        `exit ${held.code} after ${(held.ms / 1000).toFixed(1)}s; ${tail(held.out, 3)}; changed: ${differences(await snapshot(), legacy).join("; ") || "nothing"}`,
      );
      // A grant 004 cannot take back: anon's, made by service_role (REVOKE only
      // takes back the revoker's own grants, and only warns about the rest).
      await run("grant select on public.sessions to service_role with grant option");
      await run("grant select on public.sessions to anon", "service_role");
      const trapped = await snapshot();
      const refused = await migrate(MIGRATION, asPostgres);
      check(
        "004 through npm run migrate refuses a grant it cannot take back, naming it, and changes nothing",
        refused.code === 1 && /sessions: anon may SELECT/.test(refused.out) && differences(await snapshot(), trapped).length === 0,
        `exit ${refused.code}; ${tail(refused.out, 3)}; changed: ${differences(await snapshot(), trapped).join("; ") || "nothing"}`,
      );
      // Plain psql -f, which commits statement by statement: 004 is one
      // statement, so it is all or nothing there too.
      let plainPsql: string;
      try {
        plainPsql = await psql("postgres", "postgres", ["-f", path.join(BACKEND, MIGRATION)]);
      } catch (err) {
        plainPsql = `error: ${(err as Error).message}`;
      }
      check(
        "004 through plain psql -f, no single transaction: the same grant stops it, and nothing changes",
        differences(await snapshot(), trapped).length === 0,
        `psql: ${plainPsql.slice(0, 300)}; changed: ${differences(await snapshot(), trapped).join("; ")}`,
      );
      await run("revoke grant option for select on public.sessions from service_role cascade");
      check(
        "...and taking that grant away leaves production's state before 004 again",
        differences(await snapshot(), legacy).length === 0,
        differences(await snapshot(), legacy).join("\n"),
      );

      // 4. 004, as it will run on the live database.
      const applied = await migrate(MIGRATION, asPostgres);
      check("004 applies through npm run migrate, as postgres", applied.code === 0 && /^applied$/m.test(applied.out), tail(applied.out));
      const after = await report();
      check("after 004: every check of eval:security passes", failing(after).length === 0, failing(after).map((c) => `${c.name}: ${c.detail}`).join("\n"));
      check(
        "after 004: Supabase's advisor flags only spatial_ref_sys, and 0008 (INFO, no policy) lists the eight",
        advisorTables(after, "0013_rls_disabled_in_public").join() === "spatial_ref_sys" &&
          advisorTables(after, "0023_sensitive_columns_exposed").length === 0 &&
          advisorTables(after, "0008_rls_enabled_no_policy").join() === APP_TABLES.join(),
        JSON.stringify(after.advisor.map((f) => `${f.lint}:${f.table}`)),
      );
      const closed = await behaviour();
      check(
        "after 004: anon and authenticated are refused every read and write; postgres reads, writes, updates, deletes and empties a table; service_role reads",
        closed.refusedEverywhere.length === 0 && closed.backendNotAllowed.length === 0 && closed.service === "allowed",
        [...closed.refusedEverywhere, ...closed.backendNotAllowed, `service_role: ${closed.service}`].join("\n"),
      );

      // pg_dump as postgres with `npm run backup`'s own arguments (less the
      // snapshot it exports first): row level security must not stop it, and
      // the archive must carry it. pg_dump turns row_security off and refuses a
      // table it would filter; postgres owns the tables and holds BYPASSRLS.
      // The row it must find goes in as the superuser, so this judges the dump
      // alone (whether postgres may write is the check above).
      await run("insert into public.sessions (started_at, device_info) values (now(), 'eval-security-dump')", "supabase_admin");
      const archive = path.join(standIn.work, "after004.dump");
      let dumped: string;
      try {
        await runTool(
          tool("pg_dump"),
          ["--host=127.0.0.1", `--port=${standIn.port}`, "--username=postgres", "--dbname=postgres", ...dumpArgs("unused", archive).filter((a) => !a.startsWith("--snapshot"))],
          childEnv(process.env, { PGPASSWORD: password, PGSSLMODE: "disable" }),
          120_000,
        );
        const list = await runTool(tool("pg_restore"), ["--list", archive], childEnv(process.env, {}), 60_000);
        const data = await runTool(tool("pg_restore"), ["--data-only", "--file=-", archive], childEnv(process.env, {}), 60_000);
        dumped = `row security entries ${(list.match(/ ROW SECURITY /g) ?? []).length}, marker row ${data.includes("eval-security-dump") ? "present" : "missing"}`;
      } catch (err) {
        dumped = `error: ${(err as Error).message}`;
      }
      check(
        "after 004: pg_dump as postgres, with npm run backup's arguments, dumps every table, and the archive keeps all eight row level securities",
        dumped === "row security entries 8, marker row present",
        dumped.slice(0, 600),
      );
      const afterSnapshot = await snapshot();

      // A table postgres makes after 004 starts with no grant for the API's
      // roles (the defaults), and eval:security still fails it until its row
      // level security is on, which its migration must do.
      await run("create table public.later_rides (id bigserial primary key, note text)");
      const laterTable = await report();
      await run("alter table public.later_rides enable row level security");
      const laterTableClosed = await report();
      await run("drop table public.later_rides");
      check(
        "a table postgres creates after 004 starts with no grant for anon or authenticated, and eval:security fails it only for its row level security",
        laterTable.exposures.length === 0 && laterTable.rowSecurityOff.join() === "later_rides" && failing(laterTable).length === 1 && failing(laterTableClosed).length === 0,
        `exposures ${JSON.stringify(laterTable.exposures)}; rls off ${laterTable.rowSecurityOff.join()}; failing ${failing(laterTable).map((c) => c.name).join("; ")}; then ${failing(laterTableClosed).map((c) => c.name).join("; ")}`,
      );
      // A function postgres makes after 004 is executable by PUBLIC, so by
      // anon, by PostgreSQL's own default (004 says why that stays):
      // eval:security fails it until EXECUTE is revoked from PUBLIC.
      await run("create function public.later_fixes() returns bigint language sql security definer as 'select count(*) from public.session_samples'");
      const laterFunction = await report();
      const anonCalls = await attempt("select public.later_fixes()", "anon");
      await run("revoke execute on function public.later_fixes() from public");
      const laterFunctionClosed = await report();
      const anonCallsClosed = await attempt("select public.later_fixes()", "anon");
      await run("drop function public.later_fixes()");
      check(
        "a function postgres creates after 004 is open to anon through PUBLIC, eval:security fails it, and revoking EXECUTE from PUBLIC closes it",
        anonCalls === "allowed" &&
          laterFunction.exposures.map((e) => `${e.name}:${e.role}:${e.privilege}`).join() === "later_fixes():anon:EXECUTE,later_fixes():authenticated:EXECUTE" &&
          failing(laterFunction).length === 1 &&
          anonCallsClosed === "refused" &&
          failing(laterFunctionClosed).length === 0,
        `anon ${anonCalls} then ${anonCallsClosed}; exposures ${JSON.stringify(laterFunction.exposures)}; failing after the revoke: ${failing(laterFunctionClosed).map((c) => c.name).join("; ")}`,
      );
      check("...and both are gone again, leaving 004's state as it was", differences(await snapshot(), afterSnapshot).length === 0, differences(await snapshot(), afterSnapshot).join("\n"));

      // 5. Again: idempotent.
      const twice = await migrate(MIGRATION, asPostgres);
      check(
        "004 a second time: applies, and changes nothing",
        twice.code === 0 && differences(await snapshot(), afterSnapshot).length === 0,
        twice.code !== 0 ? tail(twice.out) : differences(await snapshot(), afterSnapshot).join("\n"),
      );

      // 6. The undo after 004 is the state before it, exactly.
      const undoneAgain = await migrate(UNDO, asPostgres);
      check(
        "the undo after 004 puts back exactly what was there before it",
        undoneAgain.code === 0 && differences(await snapshot(), legacy).length === 0,
        undoneAgain.code !== 0 ? tail(undoneAgain.out) : differences(await snapshot(), legacy).join("\n"),
      );

      // 7. And 004 closes it again.
      const reapplied = await migrate(MIGRATION, asPostgres);
      check(
        "004 after the undo: closed again, the same as the first time",
        reapplied.code === 0 && differences(await snapshot(), afterSnapshot).length === 0,
        reapplied.code !== 0 ? tail(reapplied.out) : differences(await snapshot(), afterSnapshot).join("\n"),
      );
    } finally {
      await pool.end();
    }
  } finally {
    const problems = await standIn.stop();
    for (const p of problems) console.log(`cleanup: ${p}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${checks.length - failed} of ${checks.length} checks passed`);
  return failed === 0;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
