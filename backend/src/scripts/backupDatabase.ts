// npm run backup [-- --no-restore-test] [-- --dropped=table,...]
//
// A backup of the live database to this PC (asked for 2026-10-25: Supabase's
// free plan keeps none). One snapshot of the database is held open while every
// app table's rows, fingerprint and definition are measured (backupFormat.ts)
// and pg_dump copies it, so the archive holds exactly the rows that were
// measured. Sequences are the exception: no snapshot holds them, so pg_dump
// reads them a moment later, and an app writing meanwhile leaves them ahead
// of the rows, never behind. The manifest records the values the archive
// holds, checked against the largest id each numbers.
//
// Before anything is dumped, the database must be one this backup can call
// complete (coverageProblems): it copies the public schema, so it refuses a
// database with no app tables, one missing a table schema.sql creates, one
// keeping app tables in another schema, and one that lost a table the last
// backup held (--dropped names one that went on purpose). The archive is then
// read back, its contents listed and every table's rows and every sequence's
// value read out of it, and saved as cyclingdataapp-<time>.dump.untested
// beside a manifest of what it holds. Last, unless told not to, the restore
// test (restoreDrill.ts) loads it into a throwaway database on this PC and
// checks every table's fingerprint and definition against production's; it
// renames the archive .dump when that passes and .dump.failed when it fails.
// Only a .dump is a backup.
//
// Read-only on production: the snapshot's transaction is READ ONLY, and
// pg_dump only reads (and takes the lightest lock, which only a table being
// altered or dropped waits on). Both connections are encrypted (TLS required,
// the certificate not yet checked): the archive is every ride's GPS fixes.
// Writes only into BACKUP_DIR (default Documents/CyclingDataApp-backups),
// never inside this repository, never over an existing file. PostgreSQL's
// tools: PG_BIN, default %LOCALAPPDATA%/CyclingDataApp/pgsql-17/bin (README,
// "Backups").
import "dotenv/config";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import {
  archiveContents,
  backupDir,
  backupFileName,
  childEnv,
  compareMeasures,
  coverageProblems,
  createArchiveReader,
  dataArgs,
  droppedTables,
  dumpArgs,
  encryptOwnConnection,
  exe,
  expectedTables,
  isInside,
  libpqEnv,
  listArgs,
  measureDatabase,
  OTHER_TABLES_SQL,
  PLATFORM_SCHEMAS,
  readManifest,
  restoredValue,
  SEQUENCE_BOUNDS_SQL,
  sequenceProblems,
  toolMajor,
  toolsDir,
  type Manifest,
  type RestoreTest,
} from "./backupFormat.js";
import { newestArchive } from "./restoreDrill.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const SCHEMA_SQL = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
const RESTORE_TEST = fileURLToPath(new URL("./restoreDrill.ts", import.meta.url));

/**
 * Runs a tool to the end, its stdout handed over line by line when asked for;
 * rejects on a non-zero exit, with the end of what it said, or on the timeout.
 */
export function runTool(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    if (onLine) readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", onLine);
    else child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err = (err + chunk.toString()).slice(-4000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(file)} ${signal ? `was stopped (${signal}) after ${timeoutMs / 1000}s` : `exited ${code}`}: ${err.trim()}`));
    });
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/** The restore test, in its own process, which is handed no production address; where the archive is once it has renamed it. */
function restoreTest(archive: string, bin: string): Promise<{ archive: string; result: RestoreTest }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RESTORE_TEST, archive], {
      env: childEnv(process.env, { PG_BIN: bin }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let outcome: { archive: string; result: RestoreTest } | null = null;
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (line.startsWith("RESULT ")) outcome = JSON.parse(line.slice("RESULT ".length)) as { archive: string; result: RestoreTest };
      else console.log(`  restore test: ${line}`);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (outcome) resolve(outcome);
      else reject(new Error(`the restore test exited ${code} without a result`));
    });
  });
}

/** The last backup's tables, from the newest .dump that passed; null before the first. */
function previousBackup(dir: string): { file: string; tables: string[] } | null {
  try {
    const archive = newestArchive(dir);
    return { file: path.basename(archive), tables: readManifest(fs.readFileSync(`${archive}.json`, "utf8")).tables.map((t) => t.name) };
  } catch {
    return null;
  }
}

async function main(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (backend/.env)");
  const bin = toolsDir();
  const pgDump = path.join(bin, exe("pg_dump"));
  const pgRestore = path.join(bin, exe("pg_restore"));
  for (const tool of [pgDump, pgRestore]) {
    if (!fs.existsSync(tool)) throw new Error(`${tool} not found: PostgreSQL 17's tools go in ${bin} (README, "Backups"), or set PG_BIN`);
  }
  const outDir = path.resolve(backupDir());
  if (isInside(outDir, REPO)) {
    throw new Error(`BACKUP_DIR ${outDir} is inside the repository: a backup is every ride's GPS fixes, and goes nowhere git could commit it`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const dumpEnv = childEnv(process.env, libpqEnv(databaseUrl));
  // pool.ts's connection: TLS, and none of the shell's PG* settings. After
  // toolsDir(), which reads PG_BIN; before the first query.
  encryptOwnConnection(process.env);

  const local = childEnv(process.env, {});
  const pgDumpVersion = (await runTool(pgDump, ["--version"], local, 30_000)).trim();
  const previous = previousBackup(outDir);
  const expected = expectedTables(fs.readFileSync(SCHEMA_SQL, "utf8"));

  const createdAt = new Date();
  const name = backupFileName(createdAt);
  const archive = path.join(outDir, name);
  const partial = `${archive}.partial`;
  const untested = `${archive}.untested`;
  const failed = `${archive}.failed`;
  for (const file of [archive, partial, untested, failed].flatMap((f) => [f, `${f}.json`])) {
    if (fs.existsSync(file)) throw new Error(`${file} exists, and nothing is overwritten`);
  }

  // One snapshot for the measures and the dump. The transaction is read-only,
  // and stays open until pg_dump is done, so pg_dump can import its snapshot.
  const started = Date.now();
  const client = await pool.connect();
  let server: { version: string; postgis: string | null };
  let measured: Awaited<ReturnType<typeof measureDatabase>>;
  let bounds: Array<{ name: string; max: number | null }>;
  try {
    // node-postgres never falls back to plain text once TLS is asked for, so
    // this is the setting that decides it: refused before any query.
    if (!client.ssl) throw new Error("the connection to the database is not encrypted, and a backup is every ride's GPS fixes (encryptOwnConnection)");
    const { rows: serverRows } = await client.query<{ version: string; postgis: string | null }>(
      `select current_setting('server_version') as version,
              (select extversion from pg_catalog.pg_extension where extname = 'postgis') as postgis`,
    );
    server = serverRows[0]!;
    const toolVersion = toolMajor(pgDumpVersion);
    if (toolVersion === null || toolVersion < Number.parseInt(server.version, 10)) {
      throw new Error(`${pgDumpVersion} is older than the server's PostgreSQL ${server.version}: pg_dump must be the server's version or newer`);
    }
    console.log(`backing up PostgreSQL ${server.version}${server.postgis ? ` with PostGIS ${server.postgis}` : ""}, with ${pgDumpVersion}`);

    await client.query("begin transaction isolation level repeatable read read only");
    const { rows } = await client.query<{ snapshot: string }>("select pg_catalog.pg_export_snapshot() as snapshot");
    measured = await measureDatabase(client);
    ({ rows: bounds } = await client.query<{ name: string; max: number | null }>(SEQUENCE_BOUNDS_SQL));
    const { rows: elsewhere } = await client.query<{ schema: string; tables: string }>(OTHER_TABLES_SQL, [PLATFORM_SCHEMAS]);
    const incomplete = coverageProblems({ tables: measured.tables.map((t) => t.name), expected, elsewhere, previous, dropped: droppedTables(process.argv) });
    if (incomplete.length > 0) {
      console.error("FAIL: not backed up, since this backup could not hold all of the app's data; nothing was written");
      for (const problem of incomplete) console.error(`  ${problem}`);
      return false;
    }
    for (const table of measured.tables) console.log(`  ${table.name.padEnd(28)} ${String(table.rows).padStart(7)} rows`);
    await runTool(pgDump, dumpArgs(rows[0]!.snapshot, partial), dumpEnv, 15 * 60_000);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
  console.log(`  dumped in ${((Date.now() - started) / 1000).toFixed(1)}s; reading it back`);

  // Read the archive back: what it lists, every row it holds, every sequence value.
  const problems: string[] = [];
  const contents = archiveContents(await runTool(pgRestore, listArgs(partial), local, 120_000));
  for (const table of measured.tables) {
    if (!contents.tables.has(table.name)) problems.push(`${table.name}: no table in the archive`);
    if (!contents.data.has(table.name)) problems.push(`${table.name}: no data in the archive`);
  }
  for (const sequence of measured.sequences) {
    if (!contents.sequenceSets.has(sequence.name)) problems.push(`sequence ${sequence.name}: no value in the archive`);
  }
  if (server.postgis && !contents.extensions.has("postgis")) problems.push("postgis: not in the archive");
  const reader = createArchiveReader();
  await runTool(pgRestore, dataArgs(partial), local, 15 * 60_000, (line) => reader.line(line));
  const { rows: archived, sequences: sets, unfinished } = reader.done();
  if (unfinished) problems.push(`${unfinished}: the archive's data ends inside its rows`);
  // Compared: the app's tables. Anything else is an extension's own (PostGIS's spatial_ref_sys).
  const appTables = new Set(measured.tables.map((t) => t.name));
  problems.push(
    ...compareMeasures(
      { tables: measured.tables, sequences: [] },
      { tables: [...archived].filter(([table]) => appTables.has(table)).map(([table, rows]) => ({ name: table, rows })) },
    ),
  );
  problems.push(...sequenceProblems(sets, bounds));
  if (problems.length > 0) {
    fs.renameSync(partial, failed);
    console.error(`FAIL: the archive does not hold what was measured; kept as ${failed}, which is not a backup`);
    for (const problem of problems) console.error(`  ${problem}`);
    return false;
  }

  const maxima = new Map(bounds.map((b) => [b.name, b.max]));
  const manifest: Manifest = {
    file: path.basename(untested),
    createdAt: createdAt.toISOString(),
    server,
    pgDump: pgDumpVersion,
    bytes: fs.statSync(partial).size,
    sha256: await sha256(partial),
    tables: measured.tables,
    schema: measured.schema,
    sequences: sets.map((s) => ({ name: s.name, lastValue: restoredValue(s), columnMax: maxima.get(s.name) ?? null })),
    restoreTests: [],
  };
  fs.renameSync(partial, untested);
  fs.writeFileSync(`${untested}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  const total = measured.tables.reduce((sum, t) => sum + t.rows, 0);
  console.log(`  ${untested}: ${(manifest.bytes / 1e6).toFixed(1)}MB, ${measured.tables.length} tables, ${total} rows, every one read back`);

  if (process.argv.includes("--no-restore-test")) {
    console.log(`UNTESTED: the archive holds what was measured, but is not a backup until its restore test passes: npm run backup:restore-test -- "${untested}"`);
    return true;
  }
  // The restore test records its result in the manifest, and renames the archive by it.
  const tested = await restoreTest(untested, bin);
  if (!tested.result.passed) {
    console.error(`FAIL: the archive did not restore as it was taken; kept as ${tested.archive}, which is not a backup`);
    for (const problem of tested.result.problems) console.error(`  ${problem}`);
    return false;
  }
  console.log(`PASS: ${tested.archive} restored into a throwaway database in ${tested.result.seconds}s, every table the same as production's`);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
