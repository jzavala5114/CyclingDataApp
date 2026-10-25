// A throwaway PostgreSQL on this PC, for the backup's restore test
// (restoreDrill.ts) and its eval (evalBackup.ts): a new cluster in a folder
// under the system's temp folder, listening only on 127.0.0.1 on a free port,
// its one role's password random and handed to nobody else (scram-sha-256, so
// another program on this PC cannot log in to read it).
//
// The folder holds a full copy of whatever is restored into it, every ride's
// GPS fixes in the restore test's case, so it does not outlive its owner when
// that can be helped. stop() removes it, and so does any other way this
// process ends that runs code: Ctrl-C or a closed window (SIGINT, SIGBREAK,
// SIGHUP), SIGTERM, or an exit anywhere, each of which stops the server and
// deletes the folder first. A process killed outright (Task Manager,
// taskkill /F, a crash) runs nothing, and its server keeps running behind its
// password until the next throwaway starts: that sweeps up every folder whose
// owner process is gone, stopping its server first.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { exe, isInside, samePath } from "./backupFormat.js";

export const WORK_PREFIX = "cyclingdataapp-throwaway-";
const OWNER_FILE = "owner.pid";

/** Runs a tool to the end, resolving with its stdout; rejects on a non-zero exit, with the end of what it said, or on the timeout. */
export function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, quiet = false): Promise<string> {
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

/** Deletes a throwaway's own folder, and only that: one under the temp folder, with the throwaway prefix. */
export function removeWork(work: string, tmp = os.tmpdir()): void {
  if (!isInside(work, tmp) || samePath(work, tmp) || !path.basename(work).startsWith(WORK_PREFIX)) {
    throw new Error(`refusing to delete ${work}: not a throwaway server's own folder`);
  }
  // A server that has just stopped can hold its files a moment longer on Windows.
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Whether a process is running: signal 0 tests for one without touching it, on Windows too. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A throwaway folder is stale when the process that made it is gone. One with
 * no owner file is stale once it is a minute old (its owner died between
 * making it and writing the file, microseconds apart, or it predates the
 * file). A dead owner's number reused by a new process makes a folder look
 * live: it waits for a later sweep, the safe way to be wrong.
 */
export function isStale(work: string, now = Date.now()): boolean {
  let owner: number;
  try {
    owner = Number(fs.readFileSync(path.join(work, OWNER_FILE), "utf8").trim());
  } catch {
    return now - fs.statSync(work).mtimeMs > 60_000;
  }
  return !Number.isInteger(owner) || owner <= 0 || !processAlive(owner);
}

/** Stops a throwaway's server, if one runs there, without waiting on anything it might say. */
function stopServerSync(pgCtl: string, data: string): void {
  if (!fs.existsSync(path.join(data, "postmaster.pid"))) return;
  spawnSync(pgCtl, ["-D", data, "-m", "immediate", "-w", "-t", "20", "stop"], { stdio: "ignore", windowsHide: true, timeout: 30_000 });
}

/** Stops and deletes every stale throwaway (isStale) under the temp folder; returns the folders it removed. */
export function sweepStale(pgCtl: string, tmp = os.tmpdir()): string[] {
  const swept: string[] = [];
  for (const name of fs.readdirSync(tmp)) {
    const work = path.join(tmp, name);
    if (!name.startsWith(WORK_PREFIX) || !fs.statSync(work).isDirectory() || !isStale(work)) continue;
    stopServerSync(pgCtl, path.join(work, "data"));
    removeWork(work, tmp);
    swept.push(work);
  }
  return swept;
}

// Every throwaway this process has running, each with the way to end it that
// needs no event loop: what an exit runs. Ctrl-C and the other signals become
// an exit, so they run it too; without a listener Node would end the process
// at once, running nothing.
const live = new Map<string, () => void>();
let listening = false;
function listenForTheEnd(): void {
  if (listening) return;
  listening = true;
  process.on("exit", () => {
    for (const end of live.values()) end();
  });
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 } as const;
  for (const [signal, code] of Object.entries(codes)) process.on(signal, () => process.exit(code));
}

export interface Throwaway {
  work: string;
  data: string;
  port: number;
  user: string;
  password: string;
  /** For pool.ts: the throwaway's address, password included, TLS off (the connection never leaves this PC). */
  url: string;
  /** For the tools (pg_restore, psql): the password and TLS off, beside --host=127.0.0.1 and the port. */
  env: Record<string, string>;
  /** Stops the server and deletes its folder; what went wrong doing that, if anything. */
  stop(): Promise<string[]>;
}

export async function startThrowaway(options: {
  bin: string;
  /** In the folder's name: restore-test, eval. */
  purpose: string;
  user: string;
  /** More lines for postgresql.conf. */
  conf?: string[];
  /** Files written into the data folder before the server starts, by name: a certificate and its key. */
  files?: Record<string, string>;
}): Promise<Throwaway> {
  const tool = (name: string) => path.join(options.bin, exe(name));
  const [initdb, pgCtl] = [tool("initdb"), tool("pg_ctl")];
  for (const swept of sweepStale(pgCtl)) console.log(`removed a stale throwaway server's folder, its owner gone: ${swept}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `${WORK_PREFIX}${options.purpose}-`));
  fs.writeFileSync(path.join(work, OWNER_FILE), String(process.pid));
  const data = path.join(work, "data");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^PG/i.test(key)) delete env[key];
  const password = randomBytes(24).toString("base64url");
  let started = false;
  const endSync = () => {
    if (started) stopServerSync(pgCtl, data);
    try {
      removeWork(work);
    } catch (err) {
      console.error(`could not delete ${work}: ${err instanceof Error ? err.message : err}`);
    }
  };
  listenForTheEnd();
  live.set(work, endSync);
  try {
    const pwfile = path.join(work, "pwfile");
    fs.writeFileSync(pwfile, password);
    try {
      await run(initdb, ["-D", data, "-U", options.user, "-A", "scram-sha-256", `--pwfile=${pwfile}`, "-E", "UTF8", "--no-locale", "--no-sync"], env, 120_000);
    } finally {
      fs.rmSync(pwfile, { force: true });
    }
    for (const [name, content] of Object.entries(options.files ?? {})) fs.writeFileSync(path.join(data, name), content);
    if (options.conf?.length) fs.appendFileSync(path.join(data, "postgresql.conf"), `\n${options.conf.join("\n")}\n`);
    const port = await freePort();
    const serverOptions = `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`;
    started = true;
    await run(pgCtl, ["-D", data, "-l", path.join(work, "server.log"), "-w", "-t", "60", "-o", serverOptions, "start"], env, 90_000, true);
    return {
      work,
      data,
      port,
      user: options.user,
      password,
      url: `postgresql://${options.user}:${password}@127.0.0.1:${port}/postgres?sslmode=disable`,
      env: { PGPASSWORD: password, PGSSLMODE: "disable" },
      // An exit during stop() still finds the folder in `live`, and finishes the job.
      async stop() {
        const problems: string[] = [];
        await run(pgCtl, ["-D", data, "-m", "fast", "-w", "stop"], env, 60_000, true).catch((err) =>
          problems.push(`stopping it: ${err instanceof Error ? err.message : err}`),
        );
        try {
          removeWork(work);
        } catch (err) {
          problems.push(`cleaning up: ${err instanceof Error ? err.message : err}`);
        }
        live.delete(work);
        return problems;
      },
    };
  } catch (err) {
    live.delete(work);
    endSync();
    throw err;
  }
}
