// The database backup's shared parts (npm run backup, scripts/backupDatabase.ts,
// and its restore test, scripts/restoreDrill.ts): what a backup records, how
// each table is measured so a copy can be compared with the original, how the
// command-line tools are called, and how their output is read. Nothing here
// connects to a database or writes a file.
//
// A table's measure is its row count and a fingerprint: md5 of the sorted md5s
// of its rows' text. Equal fingerprints mean the same rows, in any order, down
// to every value's text; the settings below fix that text (time zone, date
// style, float digits), so production and a restored copy write it the same.
// Geometry's text is its stored bytes in hex, the same in every PostGIS.
import os from "node:os";
import path from "node:path";
import type { PoolClient } from "pg";

export interface TableMeasure {
  name: string;
  rows: number;
  fingerprint: string;
}

export interface SequenceValue {
  name: string;
  lastValue: number | null;
}

export interface RestoreTest {
  passed: boolean;
  at: string;
  problems: string[];
  seconds: number;
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
  sequences: SequenceValue[];
  restoreTest: RestoreTest | null;
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

export const SEQUENCES_SQL = `
  select sequencename::text as name, last_value as "lastValue"
    from pg_catalog.pg_sequences
   where schemaname = 'public'
   order by 1`;

/**
 * Every app table's measure and every sequence's value, on a client checked
 * out of pool.ts's pool, inside a transaction the caller holds. The settings
 * fix how values are written as text, the same on both sides.
 */
export async function measureDatabase(db: Pick<PoolClient, "query">): Promise<{ tables: TableMeasure[]; sequences: SequenceValue[] }> {
  await db.query("set local timezone to 'UTC'");
  await db.query("set local datestyle to 'ISO, YMD'");
  await db.query("set local extra_float_digits to 1");
  const { rows: names } = await db.query<{ name: string }>(TABLES_SQL);
  const tables: TableMeasure[] = [];
  for (const { name } of names) {
    const { rows } = await db.query<{ rows: number; fingerprint: string }>(MEASURE_SQL, [name]);
    tables.push({ name, rows: rows[0]!.rows, fingerprint: rows[0]!.fingerprint });
  }
  const { rows: sequences } = await db.query<{ name: string; lastValue: number | null }>(SEQUENCES_SQL);
  return { tables, sequences };
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
 * The connection, as the environment variables libpq reads, so the password
 * never sits on a command line. sslmode is the caller's: production's is
 * "require", since a backup carries every ride's GPS fixes.
 */
export function libpqEnv(databaseUrl: string, sslmode: "require" | "disable"): Record<string, string> {
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
    PGSSLMODE: sslmode,
    PGCONNECT_TIMEOUT: "20",
    PGAPPNAME: "cyclingdataapp-backup",
  };
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
 * this computer.
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
 * restores just the entries the list holds.
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

/**
 * Rows per table in `pg_restore --data-only` text: the lines between each
 * "COPY public.x (...) FROM stdin;" and its "\." line. COPY's text format
 * writes one row a line, a newline in a value as \n and a backslash as \\,
 * so a line that is exactly "\." can only be the end of a table's rows.
 */
export function createRowCounter() {
  const rows = new Map<string, number>();
  let table: string | null = null;
  return {
    line(text: string) {
      if (table === null) {
        const match = /^COPY public\.("(?:[^"]|"")+"|[^\s(]+) \(.*\) FROM stdin;$/.exec(text);
        if (match) {
          const name = match[1]!;
          table = name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name;
          rows.set(table, 0);
        }
      } else if (text === "\\.") {
        table = null;
      } else {
        rows.set(table, rows.get(table)! + 1);
      }
    },
    /** Rows per table; a table still open means the text ended inside its rows. */
    done(): { rows: Map<string, number>; unfinished: string | null } {
      return { rows, unfinished: table };
    },
  };
}

// ---- files ----

/** The archive's name for a moment: sortable, no colons (Windows refuses them). */
export function backupFileName(at: Date): string {
  return `cyclingdataapp-${at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")}.dump`;
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
