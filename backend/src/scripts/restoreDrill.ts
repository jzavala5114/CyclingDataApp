// npm run backup:restore-test -- [archive]   (default: the newest in BACKUP_DIR)
//
// The backup's restore test: proves an archive from npm run backup
// (backupDatabase.ts, which runs this after every backup) restores into an
// empty database and gives back what was measured. It creates a throwaway
// PostgreSQL on this PC, in a new folder under the system's temp folder,
// listening only on 127.0.0.1 on a free port; restores the archive into it
// with pg_restore; measures every table there exactly as production was
// measured (backupFormat.ts); compares rows, fingerprints and sequences with
// the archive's manifest; then stops that PostgreSQL and deletes its folder.
//
// It never touches production. It loads no .env, refuses to start when
// DATABASE_URL is set at all, and gives pool.ts the throwaway database's
// address only after checking, through that connection, that the server
// answering is the one whose data folder it just made. pg_restore's host is
// fixed at 127.0.0.1 (restoreArgs).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  backupDir,
  childEnv,
  compareMeasures,
  exe,
  isInside,
  measureDatabase,
  restorableList,
  restoreArgs,
  toolsDir,
  type Manifest,
  type RestoreTest,
} from "./backupFormat.js";

const WORK_PREFIX = "cyclingdataapp-restore-test-";

/** Runs a tool to the end, resolving with its stdout; rejects on a non-zero exit, with the end of what it said, or on the timeout. */
function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, quiet = false): Promise<string> {
  return new Promise((resolve, reject) => {
    // pg_ctl's server keeps running after pg_ctl exits; were it handed this
    // process's pipes it would hold them open, so pg_ctl gets none (quiet).
    const child = spawn(file, args, { env, windowsHide: true, stdio: quiet ? "ignore" : ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (err = (err + chunk.toString()).slice(-4000)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(file)} ${signal ? `was stopped after ${timeoutMs / 1000}s` : `exited ${code}`}: ${err.trim()}`));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** The newest archive in the backup folder: names sort by time. */
export function newestArchive(dir: string): string {
  const archives = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^cyclingdataapp-.*\.dump$/.test(f)).sort() : [];
  if (archives.length === 0) throw new Error(`no backup in ${dir}: npm run backup makes one`);
  return path.join(dir, archives[archives.length - 1]!);
}

/** Whether two paths name one folder, as PostgreSQL and Node each write it. */
export function samePath(a: string, b: string): boolean {
  return isInside(a, b) && isInside(b, a);
}

/** Deletes the test's own folder, and only that: one under the temp folder, with the test's prefix. */
export function removeWork(work: string, tmp = os.tmpdir()): void {
  if (!isInside(work, tmp) || samePath(work, tmp) || !path.basename(work).startsWith(WORK_PREFIX)) {
    throw new Error(`refusing to delete ${work}: not a restore test's own folder`);
  }
  fs.rmSync(work, { recursive: true, force: true });
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function main(): Promise<RestoreTest> {
  if (process.env.DATABASE_URL !== undefined) {
    throw new Error("DATABASE_URL is set: the restore test runs with no database address in its environment, so it can never reach production");
  }
  const at = new Date().toISOString();
  const started = Date.now();
  const archive = path.resolve(process.argv[2] ?? newestArchive(backupDir()));
  const manifest = JSON.parse(fs.readFileSync(`${archive}.json`, "utf8")) as Manifest;
  const problems: string[] = [];
  const digest = await sha256(archive);
  if (digest !== manifest.sha256) problems.push(`the archive's sha256 is ${digest}; its manifest says ${manifest.sha256}`);

  const bin = toolsDir();
  const tool = (name: string) => {
    const file = path.join(bin, exe(name));
    if (!fs.existsSync(file)) throw new Error(`${file} not found (README, "Backups")`);
    return file;
  };
  const [initdb, pgCtl, pgRestore] = [tool("initdb"), tool("pg_ctl"), tool("pg_restore")];
  tool("postgres");
  if (manifest.server.postgis && !fs.existsSync(path.join(bin, "..", "share", "extension", "postgis.control"))) {
    throw new Error(`PostGIS is not in ${path.resolve(bin, "..")} (README, "Backups")`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), WORK_PREFIX));
  const data = path.join(work, "data");
  const env = childEnv(process.env, {});
  let running = false;
  try {
    await run(initdb, ["-D", data, "-U", "restore_test", "-A", "trust", "-E", "UTF8", "--no-locale", "--no-sync"], env, 120_000);
    const port = await freePort();
    const options = `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`;
    await run(pgCtl, ["-D", data, "-l", path.join(work, "server.log"), "-w", "-t", "60", "-o", options, "start"], env, 90_000, true);
    running = true;
    console.log(`a throwaway PostgreSQL in ${work}, on 127.0.0.1:${port}`);

    process.env.DATABASE_URL = `postgresql://restore_test@127.0.0.1:${port}/postgres`;
    const { pool } = await import("../db/pool.js");
    try {
      const { rows } = await pool.query<{ dir: string }>("select current_setting('data_directory') as dir");
      if (!samePath(rows[0]!.dir, data)) throw new Error(`the server on 127.0.0.1:${port} keeps its data in ${rows[0]!.dir}, not the throwaway ${data}`);
      const list = path.join(work, "restore.list");
      fs.writeFileSync(list, restorableList(await run(pgRestore, ["--list", archive], env, 120_000)));
      await run(pgRestore, restoreArgs(port, archive, list), childEnv(process.env, { PGSSLMODE: "disable" }), 15 * 60_000);
      console.log(`restored in ${((Date.now() - started) / 1000).toFixed(1)}s; measuring`);
      const client = await pool.connect();
      try {
        await client.query("begin transaction isolation level repeatable read read only");
        problems.push(...compareMeasures(manifest, await measureDatabase(client)));
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
    if (running) await run(pgCtl, ["-D", data, "-m", "fast", "-w", "stop"], env, 60_000, true).catch((err) => problems.push(`stopping it: ${err instanceof Error ? err.message : err}`));
    try {
      removeWork(work);
    } catch (err) {
      problems.push(`cleaning up: ${err instanceof Error ? err.message : err}`);
    }
  }
  const result: RestoreTest = { passed: problems.length === 0, at, problems, seconds: Math.round((Date.now() - started) / 100) / 10 };
  // The manifest says whether its archive is proven, so the latest test's
  // result goes in it: written beside it, then renamed over it.
  const manifestFile = `${archive}.json`;
  fs.writeFileSync(`${manifestFile}.tmp`, `${JSON.stringify({ ...manifest, restoreTest: result }, null, 2)}\n`);
  fs.renameSync(`${manifestFile}.tmp`, manifestFile);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (result) => {
      for (const problem of result.problems) console.log(`problem: ${problem}`);
      console.log(result.passed ? `PASS in ${result.seconds}s` : `FAIL in ${result.seconds}s`);
      console.log(`RESULT ${JSON.stringify(result)}`);
      process.exit(result.passed ? 0 : 1);
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
