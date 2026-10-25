// npm run backup:restore-test -- [archive]   (default: the newest backup)
//
// The backup's restore test: proves an archive from npm run backup
// (backupDatabase.ts, which runs this after every backup) restores into an
// empty database and gives back what was measured. It starts a throwaway
// PostgreSQL on this PC (throwawayServer.ts: a temp folder, 127.0.0.1 only, a
// random password); restores the archive into it with pg_restore; measures
// every table there exactly as production was measured (backupFormat.ts);
// compares rows, fingerprints, table definitions and sequence values with the
// archive's manifest; then stops that PostgreSQL and deletes its folder.
//
// Its result joins the manifest's history of restore tests, and the archive's
// name follows it (archiveState, archiveFile): .dump.untested becomes .dump
// when the test passes and .dump.failed when it fails, its manifest renamed
// with it. A later failure leaves a .dump a .dump, in the history, unless the
// archive's bytes have changed since it passed. With no archive named, it
// tests the newest .dump whose manifest says it passed.
//
// It never touches production. It loads no .env, refuses to start when
// DATABASE_URL is set at all, drops every PG* setting from its environment,
// and gives pool.ts the throwaway database's address only after checking,
// through that connection, that the server answering is the one whose data
// folder it just made. pg_restore's host is fixed at 127.0.0.1 (restoreArgs).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  archiveFile,
  archiveState,
  backupDir,
  childEnv,
  compareMeasures,
  compareSchema,
  dropLibpqSettings,
  dumpFileOf,
  exe,
  measureDatabase,
  readManifest,
  restorableList,
  restoreArgs,
  samePath,
  toolsDir,
  type Manifest,
  type RestoreTest,
} from "./backupFormat.js";
import { run, startThrowaway, type Throwaway } from "./throwawayServer.js";

/** The newest backup in the folder: the newest .dump whose manifest says it passed (names sort by time). */
export function newestArchive(dir: string): string {
  const dumps = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^cyclingdataapp-.*\.dump$/.test(f)).sort().reverse() : [];
  for (const file of dumps) {
    try {
      if (archiveState(readManifest(fs.readFileSync(path.join(dir, `${file}.json`), "utf8"))) === "passed") return path.join(dir, file);
    } catch {
      // No manifest, or not one: not a backup.
    }
  }
  throw new Error(`no backup in ${dir}: npm run backup makes one`);
}

/**
 * Adds a restore test's result to its archive's manifest, and renames archive
 * and manifest to what the history now makes them (archiveState): the new
 * manifest is written under its new name first, then the archive moves, then
 * the old manifest goes, so a stop between any two steps leaves the archive
 * with a manifest beside it. A name already taken is left alone, and the
 * archive keeps its own. Returns where the archive is now.
 */
export function recordResult(archive: string, manifest: Manifest, result: RestoreTest): string {
  const restoreTests = [...manifest.restoreTests, result];
  const dumpFile = dumpFileOf(path.basename(archive));
  const state = archiveState({ sha256: manifest.sha256, restoreTests });
  const target = dumpFile === null ? archive : path.join(path.dirname(archive), archiveFile(dumpFile, state));
  const taken = !samePath(target, archive) && (fs.existsSync(target) || fs.existsSync(`${target}.json`));
  if (taken) console.log(`${target} exists, so the archive keeps its name, ${path.basename(archive)}`);
  const final = taken ? archive : target;
  fs.writeFileSync(`${final}.json.tmp`, `${JSON.stringify({ ...manifest, file: path.basename(final), restoreTests }, null, 2)}\n`);
  fs.renameSync(`${final}.json.tmp`, `${final}.json`);
  if (!samePath(final, archive)) {
    fs.renameSync(archive, final);
    fs.rmSync(`${archive}.json`, { force: true });
  }
  return final;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function main(): Promise<{ archive: string; result: RestoreTest }> {
  if (process.env.DATABASE_URL !== undefined) {
    throw new Error("DATABASE_URL is set: the restore test runs with no database address in its environment, so it can never reach production");
  }
  const bin = toolsDir();
  const archive = path.resolve(process.argv[2] ?? newestArchive(backupDir()));
  // pool.ts's node-postgres reads PGSSLMODE and PGOPTIONS from here: none of
  // the shell's reach the throwaway's connection, which is its URL alone.
  dropLibpqSettings(process.env);
  const at = new Date().toISOString();
  const started = Date.now();
  const manifest = readManifest(fs.readFileSync(`${archive}.json`, "utf8"));
  const problems: string[] = [];
  const digest = await sha256(archive);
  if (digest !== manifest.sha256) problems.push(`the archive's sha256 is ${digest}; its manifest says ${manifest.sha256}`);

  const tool = (name: string) => {
    const file = path.join(bin, exe(name));
    if (!fs.existsSync(file)) throw new Error(`${file} not found (README, "Backups")`);
    return file;
  };
  const pgRestore = tool("pg_restore");
  for (const name of ["initdb", "pg_ctl", "postgres"]) tool(name);
  if (manifest.server.postgis && !fs.existsSync(path.join(bin, "..", "share", "extension", "postgis.control"))) {
    throw new Error(`PostGIS is not in ${path.resolve(bin, "..")} (README, "Backups")`);
  }

  let server: Throwaway | null = null;
  try {
    server = await startThrowaway({ bin, purpose: "restore-test", user: "restore_test" });
    console.log(`a throwaway PostgreSQL in ${server.work}, on 127.0.0.1:${server.port}`);
    process.env.DATABASE_URL = server.url;
    const { pool } = await import("../db/pool.js");
    try {
      const { rows } = await pool.query<{ dir: string }>("select current_setting('data_directory') as dir");
      if (!samePath(rows[0]!.dir, server.data)) {
        throw new Error(`the server on 127.0.0.1:${server.port} keeps its data in ${rows[0]!.dir}, not the throwaway ${server.data}`);
      }
      const env = childEnv(process.env, server.env);
      const list = path.join(server.work, "restore.list");
      fs.writeFileSync(list, restorableList(await run(pgRestore, ["--list", archive], env, 120_000)));
      await run(pgRestore, restoreArgs(server.port, archive, list), env, 15 * 60_000);
      console.log(`restored in ${((Date.now() - started) / 1000).toFixed(1)}s; measuring`);
      const client = await pool.connect();
      try {
        await client.query("begin transaction isolation level repeatable read read only");
        const found = await measureDatabase(client);
        problems.push(...compareMeasures(manifest, found));
        if (manifest.schema) problems.push(...compareSchema(manifest.schema, found.schema));
        else console.log("table definitions not compared: this manifest is from before they were recorded (2026-10-25)");
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    } finally {
      await pool.end();
    }
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (server) problems.push(...(await server.stop()));
  }
  const result: RestoreTest = { passed: problems.length === 0, at, problems, seconds: Math.round((Date.now() - started) / 100) / 10, sha256: digest };
  return { archive: recordResult(archive, manifest, result), result };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    ({ archive, result }) => {
      for (const problem of result.problems) console.log(`problem: ${problem}`);
      const stillABackup = dumpFileOf(path.basename(archive)) === path.basename(archive);
      if (result.passed) console.log(`PASS in ${result.seconds}s: ${archive} is a backup`);
      else if (stillABackup) console.log(`FAIL in ${result.seconds}s; ${archive} passed before, with these same bytes, so it is still a backup`);
      else console.log(`FAIL in ${result.seconds}s: ${archive} is not a backup`);
      console.log(`RESULT ${JSON.stringify({ archive, result })}`);
      process.exit(result.passed ? 0 : 1);
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
