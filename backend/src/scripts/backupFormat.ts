// The database backup's shared parts (npm run backup, scripts/backupDatabase.ts,
// and its restore test, scripts/restoreDrill.ts): what a backup records, how
// each table is measured so a copy can be compared with the original, what a
// backup must hold to be one, how the command-line tools are called, how their
// output is read, and what an archive's file name says about it. Nothing here
// connects to a database or writes a file.
//
// A table's measure is its row count and a fingerprint: md5 of the sorted md5s
// of its rows' text. Equal fingerprints mean the same rows, in any order, down
// to every value's text; the settings below fix that text (time zone, date
// style, float digits), so production and a restored copy write it the same.
// Geometry's text is its stored bytes in hex, the same in every PostGIS. Its
// schema is a list of lines, one per column, constraint, index, trigger and
// policy, written by PostgreSQL's own deparsers with the search path fixed, so
// a restored table reads line for line the same as the original.
import os from "node:os";
import path from "node:path";
import type { PoolClient } from "pg";

export interface TableMeasure {
  name: string;
  rows: number;
  fingerprint: string;
}

/** One app table's definition: a line per column, constraint, index, trigger and policy, and one for row security. */
export interface TableSchema {
  name: string;
  definition: string[];
}

/**
 * A sequence's value: pg_sequences' last_value, null before its first use.
 * In a manifest it is the value the archive holds, and columnMax the largest
 * value of the column the sequence numbers, in the backup's snapshot.
 */
export interface SequenceValue {
  name: string;
  lastValue: number | null;
  columnMax?: number | null;
}

export interface RestoreTest {
  passed: boolean;
  at: string;
  problems: string[];
  seconds: number;
  /** The archive's sha256 as this test read it; absent in tests from before 2026-10-25's fixes. */
  sha256?: string;
}

export interface Manifest {
  /** The archive's file name, beside this manifest. */
  file: string;
  createdAt: string;
  server: { version: string; postgis: string | null };
  pgDump: string;
  bytes: number;
  sha256: string;
  tables: TableMeasure[];
  /** Null in a manifest from before the schema measure (2026-10-25). */
  schema: TableSchema[] | null;
  sequences: SequenceValue[];
  /** Every restore test of this archive, oldest first. */
  restoreTests: RestoreTest[];
}

// The app's tables: public's own, not an extension's (PostGIS's
// spatial_ref_sys is PostGIS's, and pg_dump carries it with the extension).
export const TABLES_SQL = `
  select c.relname::text as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
   order by 1`;

// One table's rows and fingerprint. The table's name goes in as a value and
// is quoted by format's %I, so the statement stays fixed text (the query
// census, eval:query-types, reads every statement from the source).
export const MEASURE_SQL = `
  select (xpath('/row/n/text()', q.x))[1]::text::bigint as rows,
         (xpath('/row/f/text()', q.x))[1]::text as fingerprint
    from (select query_to_xml(
                   format('select count(*) as n, md5(coalesce(string_agg(h, '''' order by h collate "C"), '''')) as f
                             from (select md5(t::text) as h from public.%I t) s', $1::text),
                   false, true, '') as x) q`;

// Every app table's definition, a line each, by PostgreSQL's own deparsers:
// columns in order (a column's number counts live columns only, since a
// restore renumbers past dropped ones), constraints, indexes, triggers,
// policies and row security. The search path is fixed (measureDatabase), so
// names come out schema-qualified the same on both sides. In PostgreSQL 17 a
// NOT NULL is a column's flag, not a constraint, so the column line has it.
export const SCHEMA_SQL = `
  with app as (
    select c.oid, c.relname::text as name, c.relrowsecurity, c.relforcerowsecurity, c.relpersistence
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and not exists (
         select 1 from pg_catalog.pg_depend d
          where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'))
  select app.name, lines.line
    from app, lateral (
      select format('table: row security %s%s, %s',
                    case when app.relrowsecurity then 'on' else 'off' end,
                    case when app.relforcerowsecurity then ' (forced)' else '' end,
                    case when app.relpersistence = 'u' then 'unlogged' else 'logged' end) as line
      union all
      select format('column %s: %s %s%s%s%s%s',
                    row_number() over (order by a.attnum), a.attname,
                    pg_catalog.format_type(a.atttypid, a.atttypmod),
                    case when a.attnotnull then ' not null' else '' end,
                    case when ad.adbin is not null then ' default ' || pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) else '' end,
                    case a.attidentity when 'a' then ' identity always' when 'd' then ' identity by default' else '' end,
                    case when a.attgenerated = 's' then ' generated' else '' end)
        from pg_catalog.pg_attribute a
        left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
       where a.attrelid = app.oid and a.attnum > 0 and not a.attisdropped
      union all
      select format('constraint %s: %s', co.conname, pg_catalog.pg_get_constraintdef(co.oid))
        from pg_catalog.pg_constraint co
       where co.conrelid = app.oid
      union all
      select format('index %s', pg_catalog.pg_get_indexdef(i.indexrelid))
        from pg_catalog.pg_index i
       where i.indrelid = app.oid
      union all
      select format('trigger %s', pg_catalog.pg_get_triggerdef(t.oid))
        from pg_catalog.pg_trigger t
       where t.tgrelid = app.oid and not t.tgisinternal
      union all
      select format('policy %s: %s for %s to %s using %s with check %s', p.policyname, p.permissive, p.cmd,
                    array_to_string(p.roles, ','), coalesce(p.qual, '-'), coalesce(p.with_check, '-'))
        from pg_catalog.pg_policies p
       where p.schemaname = 'public' and p.tablename = app.name) lines
   order by 1, 2`;

export const SEQUENCES_SQL = `
  select sequencename::text as name, last_value as "lastValue"
    from pg_catalog.pg_sequences
   where schemaname = 'public'
   order by 1`;

// Each public sequence that numbers a column (serial's or identity's), and the
// largest value in that column: a restored sequence at or above it can never
// hand out an id that is already taken. The column and table go in through
// format's %I, as in MEASURE_SQL.
export const SEQUENCE_BOUNDS_SQL = `
  select s.relname::text as name,
         (xpath('/row/m/text()',
                query_to_xml(format('select max(%I) as m from public.%I', a.attname, t.relname), false, true, '')))[1]::text::bigint as max
    from pg_catalog.pg_class s
    join pg_catalog.pg_namespace n on n.oid = s.relnamespace
    join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_class'::regclass and d.objid = s.oid
                               and d.refclassid = 'pg_catalog.pg_class'::regclass and d.deptype in ('a', 'i')
    join pg_catalog.pg_class t on t.oid = d.refobjid and t.relnamespace = s.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
   where s.relkind = 'S' and n.nspname = 'public'
   order by 1`;

/**
 * The schemas whose tables are the platform's, not the app's: PostgreSQL's
 * own (pg_catalog, pg_toast and every other pg_ name are left out by the
 * query) and Supabase's. Production had tables in auth, realtime, storage and
 * vault on 2026-10-25; the rest are the ones Supabase creates in other
 * projects. A table anywhere else is the app's, and the backup, which copies
 * public only, refuses to call itself complete while one exists.
 */
export const PLATFORM_SCHEMAS = [
  "information_schema",
  "auth",
  "storage",
  "realtime",
  "vault",
  "extensions",
  "graphql",
  "graphql_public",
  "pgsodium",
  "pgsodium_masks",
  "net",
  "supabase_functions",
  "supabase_migrations",
  "cron",
  "pgbouncer",
  "_realtime",
  "_analytics",
  "_supavisor",
];

export const OTHER_TABLES_SQL = `
  select n.nspname::text as schema, string_agg(c.relname::text, ', ' order by c.relname) as tables
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname <> 'public' and n.nspname !~ '^pg_'
     and n.nspname <> all ($1::text[])
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
   group by 1
   order by 1`;

/**
 * Every app table's measure and definition and every sequence's value, on a
 * client checked out of pool.ts's pool, inside a transaction the caller holds.
 * The settings fix how values and names are written as text, the same on both
 * sides.
 */
export async function measureDatabase(
  db: Pick<PoolClient, "query">,
): Promise<{ tables: TableMeasure[]; schema: TableSchema[]; sequences: SequenceValue[] }> {
  await db.query("set local timezone to 'UTC'");
  await db.query("set local datestyle to 'ISO, YMD'");
  await db.query("set local extra_float_digits to 1");
  await db.query("set local search_path to pg_catalog");
  const { rows: names } = await db.query<{ name: string }>(TABLES_SQL);
  const tables: TableMeasure[] = [];
  for (const { name } of names) {
    const { rows } = await db.query<{ rows: number; fingerprint: string }>(MEASURE_SQL, [name]);
    tables.push({ name, rows: rows[0]!.rows, fingerprint: rows[0]!.fingerprint });
  }
  const { rows: lines } = await db.query<{ name: string; line: string }>(SCHEMA_SQL);
  const schema = names.map(({ name }) => ({ name, definition: lines.filter((l) => l.name === name).map((l) => l.line) }));
  const { rows: sequences } = await db.query<{ name: string; lastValue: number | null }>(SEQUENCES_SQL);
  return { tables, schema, sequences };
}

/** What differs between a backup's record and what was found; empty when they match. */
export function compareMeasures(
  expected: { tables: TableMeasure[]; sequences: SequenceValue[] },
  found: { tables: Array<{ name: string; rows: number; fingerprint?: string }>; sequences?: SequenceValue[] },
): string[] {
  const problems: string[] = [];
  const byName = new Map(found.tables.map((t) => [t.name, t]));
  for (const table of expected.tables) {
    const got = byName.get(table.name);
    if (!got) problems.push(`${table.name}: missing`);
    else if (got.rows !== table.rows) problems.push(`${table.name}: ${got.rows} rows, the original has ${table.rows}`);
    else if (got.fingerprint !== undefined && got.fingerprint !== table.fingerprint) {
      problems.push(`${table.name}: same ${table.rows} rows, different contents (fingerprint ${got.fingerprint}, the original ${table.fingerprint})`);
    }
  }
  const expectedNames = new Set(expected.tables.map((t) => t.name));
  for (const table of found.tables) if (!expectedNames.has(table.name)) problems.push(`${table.name}: not in the original`);
  if (found.sequences) {
    const sequences = new Map(found.sequences.map((s) => [s.name, s.lastValue]));
    for (const sequence of expected.sequences) {
      if (!sequences.has(sequence.name)) problems.push(`sequence ${sequence.name}: missing`);
      else if (sequences.get(sequence.name) !== sequence.lastValue) {
        problems.push(`sequence ${sequence.name}: at ${sequences.get(sequence.name)}, the original at ${sequence.lastValue}`);
      }
    }
  }
  return problems;
}

/** What differs between the tables' recorded definitions and the ones found: each line one side has and the other lacks. */
export function compareSchema(expected: TableSchema[], found: TableSchema[]): string[] {
  const problems: string[] = [];
  const byName = new Map(found.map((t) => [t.name, new Set(t.definition)]));
  for (const table of expected) {
    const got = byName.get(table.name);
    if (!got) {
      problems.push(`${table.name}: no definition found`);
      continue;
    }
    const want = new Set(table.definition);
    for (const line of table.definition) if (!got.has(line)) problems.push(`${table.name}: missing ${line}`);
    for (const line of got) if (!want.has(line)) problems.push(`${table.name}: not in the original: ${line}`);
  }
  const expectedNames = new Set(expected.map((t) => t.name));
  for (const table of found) if (!expectedNames.has(table.name)) problems.push(`${table.name}: a definition the original does not have`);
  return problems;
}

// ---- what a backup must hold ----

/**
 * The tables a fresh install creates: each `create table` in schema.sql (the
 * migrations' tables are there too, by the rule each migration's header
 * states). The backup refuses to pass without every one of them.
 */
export function expectedTables(schemaSql: string): string[] {
  const names = new Set<string>();
  const statements = /^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/gim;
  for (const match of schemaSql.matchAll(statements)) names.add(match[1]!);
  return [...names].sort();
}

/** The tables `--dropped=a,b` says went on purpose since the last backup. */
export function droppedTables(argv: string[]): string[] {
  return argv.filter((a) => a.startsWith("--dropped=")).flatMap((a) => a.slice("--dropped=".length).split(",")).map((t) => t.trim()).filter(Boolean);
}

/**
 * Why a database is not one this backup can call complete; empty when it is.
 * It copies public only, so it refuses: no app tables at all; a table
 * schema.sql creates that public lacks; a table in a schema it does not copy
 * (PLATFORM_SCHEMAS are Supabase's own); and a table the last backup held that
 * is gone now, unless --dropped names it.
 */
export function coverageProblems(input: {
  tables: string[];
  expected: string[];
  elsewhere: Array<{ schema: string; tables: string }>;
  previous: { file: string; tables: string[] } | null;
  dropped: string[];
}): string[] {
  const problems: string[] = [];
  const have = new Set(input.tables);
  if (input.tables.length === 0) problems.push("public holds no app tables: this would be a backup of nothing");
  const missing = input.expected.filter((t) => !have.has(t));
  for (const table of missing) problems.push(`${table}: schema.sql creates it, and public has no such table`);
  for (const { schema, tables } of input.elsewhere) {
    problems.push(`schema ${schema} holds tables this backup does not copy (it copies public only): ${tables}`);
  }
  if (input.previous) {
    for (const table of input.previous.tables) {
      if (have.has(table) || missing.includes(table) || input.dropped.includes(table)) continue;
      problems.push(`${table}: in the last backup (${input.previous.file}) and gone now; if it was dropped on purpose, run with --dropped=${table}`);
    }
  }
  return problems;
}

/**
 * Why an archive's sequence values could not be restored safely; empty when
 * they can. Each sequence that numbers a column must be in the archive, at or
 * above that column's largest value in the snapshot (if it has not handed out
 * a value yet, above it): pg_dump reads sequences after the snapshot, so they
 * can be ahead of the rows but never behind. Sequences here count up by 1.
 */
export function sequenceProblems(archived: SequenceSet[], bounds: Array<{ name: string; max: number | null }>): string[] {
  const problems: string[] = [];
  const byName = new Map(archived.map((s) => [s.name, s]));
  for (const bound of bounds) {
    const set = byName.get(bound.name);
    if (!set) problems.push(`sequence ${bound.name}: no value in the archive`);
    else if (bound.max !== null && (set.called ? set.value < bound.max : set.value <= bound.max)) {
      problems.push(`sequence ${bound.name}: the archive has it at ${set.value}${set.called ? "" : " (unused)"}, below the ${bound.max} its column already holds`);
    }
  }
  return problems;
}

// ---- the command-line tools ----

export const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

/** Where PostgreSQL's tools are: PG_BIN, else the folder the backup's README sets up. */
export function toolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PG_BIN ?? path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "CyclingDataApp", "pgsql-17", "bin");
}

/** Where backups go: BACKUP_DIR, else Documents/CyclingDataApp-backups. */
export function backupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BACKUP_DIR ?? path.join(os.homedir(), "Documents", "CyclingDataApp-backups");
}

/** The major version in a tool's `--version` line: "pg_dump (PostgreSQL) 17.11" is 17. */
export function toolMajor(versionLine: string): number | null {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(versionLine);
  return match ? Number(match[1]) : null;
}

/**
 * pg_dump's connection, as the environment variables libpq reads, so the
 * password never sits on a command line. TLS is required, always: the
 * archive is every ride's GPS fixes. A database to back up must have TLS on,
 * a local one included (the review's stand-in had a self-signed certificate).
 * "require" encrypts without checking the certificate; checking it against
 * Supabase's CA (verify-full) waits on the same fix for pool.ts.
 */
export function libpqEnv(databaseUrl: string): Record<string, string> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error(`DATABASE_URL is ${url.protocol}, not postgres`);
  if (!url.hostname || !url.username) throw new Error("DATABASE_URL has no host or no user");
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    PGSSLMODE: "require",
    PGCONNECT_TIMEOUT: "20",
    PGAPPNAME: "cyclingdataapp-backup",
  };
}

/**
 * Removes every libpq setting (PG*) from an environment, in place. node-postgres
 * reads some of them too (PGSSLMODE, PGOPTIONS), so a script that reaches a
 * database through pool.ts runs this on process.env before its first query:
 * its connection is then DATABASE_URL and what the script sets, nothing the
 * shell had. PG_BIN goes too, so read toolsDir() first.
 */
export function dropLibpqSettings(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) if (/^PG/i.test(key)) delete env[key];
}

/**
 * The backup's own connection to production (pool.ts's): the shell's libpq
 * settings dropped, and TLS required without checking the certificate, which
 * node-postgres calls "no-verify" (its "require" checks the certificate, and
 * Supabase's is signed by a CA Node does not carry). Matches pg_dump's
 * "require" (libpqEnv). Before its first query; backupDatabase.ts also refuses
 * a checked-out connection that is not encrypted.
 */
export function encryptOwnConnection(env: NodeJS.ProcessEnv): void {
  dropLibpqSettings(env);
  env.PGSSLMODE = "no-verify";
}

/**
 * The environment a tool runs with: this process's, less every libpq setting
 * and DATABASE_URL, plus exactly the ones given. A PGHOST or PGPASSWORD left
 * in the shell can then never point a tool somewhere it was not sent.
 */
export function childEnv(base: NodeJS.ProcessEnv, settings: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^PG/i.test(key) || /^DATABASE_URL$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...settings };
}

/**
 * pg_dump's arguments: the public schema and PostGIS, in pg_dump's own
 * compressed format, read inside the snapshot the measures were taken in, so
 * the archive holds exactly the rows they counted. No owners or grants: a
 * restore makes everything the restoring role's, and leaves out the anon
 * grants Supabase had. The connection comes from the environment only.
 */
export function dumpArgs(snapshot: string, file: string): string[] {
  return [
    "--format=custom",
    "--schema=public",
    "--extension=postgis",
    "--no-owner",
    "--no-privileges",
    "--lock-wait-timeout=30s",
    `--snapshot=${snapshot}`,
    `--file=${file}`,
  ];
}

/** pg_restore's arguments to list an archive's contents; it reads the file and connects to nothing. */
export const listArgs = (file: string) => ["--list", file];

/** pg_restore's arguments to write an archive's data out as text, on stdout; it connects to nothing. */
export const dataArgs = (file: string) => ["--data-only", "--file=-", file];

/**
 * pg_restore's arguments to load an archive into the restore test's
 * throwaway database, the entries in `list` only (restorableList). The host
 * is written here, never taken from anywhere, so this can only ever reach
 * this computer. The password comes from the environment.
 */
export function restoreArgs(port: number, file: string, list: string): string[] {
  return [
    "--host=127.0.0.1",
    `--port=${port}`,
    "--username=restore_test",
    "--dbname=postgres",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    `--use-list=${list}`,
    file,
  ];
}

/**
 * An archive's list without its "CREATE SCHEMA public": every database
 * already has a public schema, so restoring that entry fails ("schema public
 * already exists") into a new Supabase project as into the restore test's.
 * The schema's comment and everything in it are kept. pg_restore --use-list
 * restores just the entries the list holds. Widening this filter drops what
 * it matches from every restore; the restore test's schema measure fails one
 * that drops an index, a constraint or a default.
 */
export function restorableList(list: string): string {
  return list
    .split(/\r?\n/)
    .filter((line) => !/^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+public\s/.test(line))
    .join("\n");
}

// ---- reading the tools' output ----

/** What `pg_restore --list` says an archive holds: its tables, their data, sequence values, extensions. */
export function archiveContents(list: string): { tables: Set<string>; data: Set<string>; sequenceSets: Set<string>; extensions: Set<string> } {
  const contents = { tables: new Set<string>(), data: new Set<string>(), sequenceSets: new Set<string>(), extensions: new Set<string>() };
  for (const line of list.split(/\r?\n/)) {
    // "215; 1259 17236 TABLE public sessions postgres": an entry, not a ";" comment.
    const match = /^\d+;\s+\d+\s+\d+\s+(TABLE DATA|TABLE|SEQUENCE SET|EXTENSION)\s+(\S+)\s+(\S+)/.exec(line);
    if (!match) continue;
    const [, kind, schema, name] = match as unknown as [string, string, string, string];
    if (kind === "EXTENSION") contents.extensions.add(name);
    else if (schema !== "public") continue;
    else if (kind === "TABLE") contents.tables.add(name);
    else if (kind === "TABLE DATA") contents.data.add(name);
    else contents.sequenceSets.add(name);
  }
  return contents;
}

/** A sequence's value as an archive sets it: setval(name, value, called). */
export interface SequenceSet {
  name: string;
  value: number;
  called: boolean;
}

/** An identifier as PostgreSQL writes one: bare, or in double quotes with each quote doubled. */
const unquote = (id: string) => (id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id);

/**
 * Reads `pg_restore --data-only` text line by line. Rows per table: the lines
 * between each "COPY public.x (...) FROM stdin;" and its "\." line. COPY's
 * text format writes one row a line, a newline in a value as \n and a
 * backslash as \\, so a line that is exactly "\." can only be the end of a
 * table's rows. Sequence values: each public sequence's
 * "SELECT pg_catalog.setval('public.x', 89, true);" line, outside any COPY.
 */
export function createArchiveReader() {
  const rows = new Map<string, number>();
  const sequences: SequenceSet[] = [];
  let table: string | null = null;
  return {
    line(text: string) {
      if (table === null) {
        const copy = /^COPY public\.("(?:[^"]|"")+"|[^\s(]+) \(.*\) FROM stdin;$/.exec(text);
        if (copy) {
          table = unquote(copy[1]!);
          rows.set(table, 0);
          return;
        }
        // The name is a string literal holding a qualified name: 'public."a""b"' is public."a""b", the sequence a"b.
        const setval = /^SELECT pg_catalog\.setval\('((?:[^']|'')+)', (-?\d+), (true|false)\);$/.exec(text);
        const qualified = setval ? /^public\.("(?:[^"]|"")+"|[^".]+)$/.exec(setval[1]!.replace(/''/g, "'")) : null;
        if (setval && qualified) sequences.push({ name: unquote(qualified[1]!), value: Number(setval[2]), called: setval[3] === "true" });
      } else if (text === "\\.") {
        table = null;
      } else {
        rows.set(table, rows.get(table)! + 1);
      }
    },
    /** Rows per table, and sequence values; a table still open means the text ended inside its rows. */
    done(): { rows: Map<string, number>; sequences: SequenceSet[]; unfinished: string | null } {
      return { rows, sequences, unfinished: table };
    },
  };
}

/** A setval as pg_sequences would show it once restored: its value, or null if not yet used. */
export const restoredValue = (set: SequenceSet): number | null => (set.called ? set.value : null);

// ---- files ----

/** The archive's name for a moment: sortable, no colons (Windows refuses them). */
export function backupFileName(at: Date): string {
  return `cyclingdataapp-${at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")}.dump`;
}

/**
 * What an archive is, by its restore tests: a backup once one has passed;
 * failed when tested and none has, or when the latest test read different
 * bytes from the ones the backup recorded (the file changed after it passed,
 * so that pass no longer covers it); untested before any test. A failure
 * after a pass, with the bytes unchanged, does not undo the pass: it is the
 * test's environment that changed (a shell setting, a missing tool), not the
 * archive, and it stays in the history.
 */
export type ArchiveState = "untested" | "passed" | "failed";

export function archiveState(manifest: Pick<Manifest, "sha256" | "restoreTests">): ArchiveState {
  const tests = manifest.restoreTests;
  if (tests.length === 0) return "untested";
  const latest = tests[tests.length - 1]!;
  if (latest.sha256 !== undefined && latest.sha256 !== manifest.sha256) return "failed";
  return tests.some((t) => t.passed) ? "passed" : "failed";
}

/**
 * An archive's file name says what it is: cyclingdataapp-<time>.dump is a
 * backup (its restore test passed); .dump.untested has not been tested yet;
 * .dump.failed is not a backup. Its manifest is the same name plus .json.
 */
export function archiveFile(dumpFile: string, state: ArchiveState): string {
  return state === "passed" ? dumpFile : `${dumpFile}.${state}`;
}

/** The .dump name an archive file was given, whatever it is now; null for a name the backup never writes. */
export function dumpFileOf(file: string): string | null {
  const match = /^(cyclingdataapp-.+\.dump)(?:\.untested|\.failed)?$/.exec(file);
  return match ? match[1]! : null;
}

/**
 * A manifest as read from disk, in today's shape. Manifests written before
 * 2026-10-25's fixes have one `restoreTest` (the latest) instead of the
 * history, and no schema.
 */
export function readManifest(text: string): Manifest {
  const raw = JSON.parse(text) as Manifest & { restoreTest?: RestoreTest | null };
  const { restoreTest, ...rest } = raw;
  return {
    ...rest,
    schema: raw.schema ?? null,
    restoreTests: raw.restoreTests ?? (restoreTest ? [restoreTest] : []),
  };
}

/** Whether `child` is `parent` or inside it; Windows paths compare without case. */
export function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(norm(parent), norm(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Whether two paths name one folder or file, as PostgreSQL and Node each write it. */
export function samePath(a: string, b: string): boolean {
  return isInside(a, b) && isInside(b, a);
}
