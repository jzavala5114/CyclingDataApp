// npm run backup [-- --no-restore-test]
//
// A backup of the live database to this PC (asked for 2026-10-25: Supabase's
// free plan keeps none). One snapshot of the database is held open while every
// app table's rows and fingerprint are measured (backupFormat.ts) and pg_dump
// copies it, so the archive holds exactly what was measured. The archive is
// then read back: its contents listed and every table's rows counted out of it
// against the measures; only then is it named as a backup, beside a manifest
// of what it holds. Last, unless told not to, the restore test
// (restoreDrill.ts) loads it into a throwaway database on this PC and checks
// every table's fingerprint against production's.
//
// Read-only on production: the snapshot's transaction is READ ONLY, and
// pg_dump only reads (and takes the lightest lock, which only a table being
// altered or dropped waits on). Its connection is encrypted (sslmode
// require): the archive is every ride's GPS fixes. Writes only into BACKUP_DIR
// (default Documents/CyclingDataApp-backups), never inside this repository,
// never over an existing file. PostgreSQL's tools: PG_BIN, default
// %LOCALAPPDATA%/CyclingDataApp/pgsql-17/bin (README, "Backups").
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
  createRowCounter,
  dataArgs,
  dumpArgs,
  exe,
  isInside,
  libpqEnv,
  listArgs,
  measureDatabase,
  toolMajor,
  toolsDir,
  type Manifest,
  type RestoreTest,
} from "./backupFormat.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
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

/** The restore test, in its own process, which is handed no production address. */
function restoreTest(archive: string, bin: string): Promise<RestoreTest> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RESTORE_TEST, archive], {
      env: childEnv(process.env, { PG_BIN: bin }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let result: RestoreTest | null = null;
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (line.startsWith("RESULT ")) result = JSON.parse(line.slice("RESULT ".length)) as RestoreTest;
      else console.log(`  restore test: ${line}`);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (result) resolve(result);
      else reject(new Error(`the restore test exited ${code} without a result`));
    });
  });
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

  const local = childEnv(process.env, {});
  const pgDumpVersion = (await runTool(pgDump, ["--version"], local, 30_000)).trim();
  const { rows: serverRows } = await pool.query<{ version: string; postgis: string | null }>(
    `select current_setting('server_version') as version,
            (select extversion from pg_catalog.pg_extension where extname = 'postgis') as postgis`,
  );
  const server = serverRows[0]!;
  const toolVersion = toolMajor(pgDumpVersion);
  if (toolVersion === null || toolVersion < Number.parseInt(server.version, 10)) {
    throw new Error(`${pgDumpVersion} is older than the server's PostgreSQL ${server.version}: pg_dump must be the server's version or newer`);
  }

  const createdAt = new Date();
  const name = backupFileName(createdAt);
  const archive = path.join(outDir, name);
  const partial = `${archive}.partial`;
  for (const file of [archive, partial, `${archive}.json`]) {
    if (fs.existsSync(file)) throw new Error(`${file} exists, and nothing is overwritten`);
  }
  console.log(`backing up PostgreSQL ${server.version}${server.postgis ? ` with PostGIS ${server.postgis}` : ""}, with ${pgDumpVersion}`);

  // One snapshot for the measures and the dump. The transaction is read-only,
  // and stays open until pg_dump is done, so pg_dump can import its snapshot.
  const started = Date.now();
  const client = await pool.connect();
  let measured: Awaited<ReturnType<typeof measureDatabase>>;
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const { rows } = await client.query<{ snapshot: string }>("select pg_catalog.pg_export_snapshot() as snapshot");
    measured = await measureDatabase(client);
    for (const table of measured.tables) console.log(`  ${table.name.padEnd(28)} ${String(table.rows).padStart(7)} rows`);
    await runTool(pgDump, dumpArgs(rows[0]!.snapshot, partial), childEnv(process.env, libpqEnv(databaseUrl, "require")), 15 * 60_000);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
  console.log(`  dumped in ${((Date.now() - started) / 1000).toFixed(1)}s; reading it back`);

  // Read the archive back: what it lists, and every row it holds.
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
  const counter = createRowCounter();
  await runTool(pgRestore, dataArgs(partial), local, 15 * 60_000, (line) => counter.line(line));
  const { rows: archived, unfinished } = counter.done();
  if (unfinished) problems.push(`${unfinished}: the archive's data ends inside its rows`);
  // Compared: the app's tables. Anything else is an extension's own (PostGIS's spatial_ref_sys).
  const appTables = new Set(measured.tables.map((t) => t.name));
  problems.push(
    ...compareMeasures(
      { tables: measured.tables, sequences: [] },
      { tables: [...archived].filter(([table]) => appTables.has(table)).map(([table, rows]) => ({ name: table, rows })) },
    ),
  );
  if (problems.length > 0) {
    fs.renameSync(partial, `${archive}.failed`);
    console.error(`FAIL: the archive does not hold what was measured; kept as ${archive}.failed, which is not a backup`);
    for (const problem of problems) console.error(`  ${problem}`);
    return false;
  }

  const manifest: Manifest = {
    file: name,
    createdAt: createdAt.toISOString(),
    server,
    pgDump: pgDumpVersion,
    bytes: fs.statSync(partial).size,
    sha256: await sha256(partial),
    tables: measured.tables,
    sequences: measured.sequences,
    restoreTest: null,
  };
  fs.renameSync(partial, archive);
  fs.writeFileSync(`${archive}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  const total = measured.tables.reduce((sum, t) => sum + t.rows, 0);
  console.log(`  ${archive}: ${(manifest.bytes / 1e6).toFixed(1)}MB, ${measured.tables.length} tables, ${total} rows, every one read back`);

  if (process.argv.includes("--no-restore-test")) {
    console.log("PASS (archive checked; restore test skipped)");
    return true;
  }
  // The restore test records its result in the manifest itself.
  const tested = await restoreTest(archive, bin);
  if (!tested.passed) {
    console.error(`FAIL: the archive did not restore as it was taken (${archive} is kept, unproven)`);
    for (const problem of tested.problems) console.error(`  ${problem}`);
    return false;
  }
  console.log(`PASS: restored into a throwaway database in ${tested.seconds}s, every table the same as production's`);
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
