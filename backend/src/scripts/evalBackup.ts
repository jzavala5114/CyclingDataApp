// npm run eval:backup
//
// The backup's eval: runs npm run backup and its restore test for real,
// against a stand-in for production on this PC, in each situation the cold
// review of 2026-10-25 used to break them, and checks each now ends the way
// it must. The stand-in is a throwaway PostgreSQL (throwawayServer.ts) with
// TLS on (a self-signed certificate from openssl, which Git for Windows
// carries; OPENSSL to name another), loaded from the newest backup, so it holds
// production's tables and rows as of then. Every archive it makes goes into
// the stand-in's own folder, deleted with it.
//
// Nothing here reaches production: it loads no .env, refuses to start with
// DATABASE_URL set, and gives every backup it runs the stand-in's address
// (dotenv, which backupDatabase.ts loads, never replaces a variable already
// set). About two minutes. Exits 1 if any check fails.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { backupDir, childEnv, exe, readManifest, toolsDir, type Manifest } from "./backupFormat.js";
import { newestArchive } from "./restoreDrill.js";
import { run, startThrowaway, type Throwaway } from "./throwawayServer.js";

const BACKUP = fileURLToPath(new URL("./backupDatabase.ts", import.meta.url));
const RESTORE_TEST = fileURLToPath(new URL("./restoreDrill.ts", import.meta.url));
const BACKEND = fileURLToPath(new URL("../..", import.meta.url));

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail.split("\n").join("\n      ")}`}`);
}

/** Runs a script of this service in its own node, as npm would; its exit code and everything it printed. */
function script(file: string, args: string[], env: NodeJS.ProcessEnv, onLine?: (line: string) => void): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", file, ...args], { cwd: BACKEND, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => {
        lines.push(line);
        onLine?.(line);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: lines.join("\n") }));
  });
}

const tail = (out: string, n = 12) => out.split("\n").slice(-n).join("\n");

function openssl(): string {
  const candidates = [process.env.OPENSSL, "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"];
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) throw new Error("openssl not found: Git for Windows carries one; or set OPENSSL to an openssl.exe");
  return found;
}

/** A certificate and key for the stand-in: self-signed, for 127.0.0.1, a day long, made in a temp folder deleted after. */
async function certificate(): Promise<Record<string, string>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyclingdataapp-eval-cert-"));
  try {
    const config = path.join(dir, "openssl.cnf");
    fs.writeFileSync(config, "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = 127.0.0.1\n");
    const [crt, key] = [path.join(dir, "server.crt"), path.join(dir, "server.key")];
    await run(openssl(), ["req", "-new", "-x509", "-days", "1", "-nodes", "-newkey", "rsa:2048", "-config", config, "-keyout", key, "-out", crt], childEnv(process.env, {}), 60_000);
    return { "server.crt": fs.readFileSync(crt, "utf8"), "server.key": fs.readFileSync(key, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The files a backup left in its folder, and the manifest of the one archive with that state. */
function backupsIn(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}
const manifestOf = (dir: string, file: string): Manifest => readManifest(fs.readFileSync(path.join(dir, `${file}.json`), "utf8"));
/** The archive a restore test takes by default from a folder, or "none". */
function defaultArchive(dir: string): string {
  try {
    return path.basename(newestArchive(dir));
  } catch {
    return "none";
  }
}

async function main(): Promise<boolean> {
  if (process.env.DATABASE_URL !== undefined) throw new Error("DATABASE_URL is set: the eval runs with no database address of its own, so no backup it runs can reach production");
  const bin = toolsDir();
  const [psql, pgRestore] = [path.join(bin, exe("psql")), path.join(bin, exe("pg_restore"))];
  const source = newestArchive(backupDir());
  console.log(`a stand-in for production, loaded from ${source}`);

  const standIn: Throwaway = await startThrowaway({
    bin,
    purpose: "eval",
    user: "standin",
    files: await certificate(),
    conf: ["ssl = on", "ssl_cert_file = 'server.crt'", "ssl_key_file = 'server.key'", "log_connections = on"],
  });
  try {
    const tools = childEnv(process.env, standIn.env);
    const sql = (...statements: string[]) =>
      run(psql, ["-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(standIn.port), "-U", "standin", "-d", "postgres", "-Atq", ...statements.flatMap((s) => ["-c", s])], tools, 120_000);
    // Restored as the README's "Restoring for real" restores, with its own
    // filter, not restorableList: the eval judges restorableList (the restore
    // test uses it), so the production it judges against cannot be built with
    // it. A mutant that drops indexes from both would pass unseen.
    const list = path.join(standIn.work, "restore.list");
    const readmeFilter = (text: string) => text.split(/\r?\n/).filter((l) => !/^[0-9]+; +[0-9]+ +[0-9]+ +SCHEMA - public /.test(l)).join("\n");
    fs.writeFileSync(list, readmeFilter(await run(pgRestore, ["--list", source], tools, 120_000)));
    await run(pgRestore, ["--host=127.0.0.1", `--port=${standIn.port}`, "--username=standin", "--dbname=postgres", "--no-owner", "--no-privileges", "--exit-on-error", `--use-list=${list}`, source], tools, 15 * 60_000);
    console.log(`  ${(await sql("select count(*) from public.session_samples")).trim()} GPS fixes in the stand-in, on 127.0.0.1:${standIn.port}, TLS on\n`);

    // Every backup gets the stand-in's address and a folder of its own, and none of the shell's PG* or BACKUP_DIR.
    const url = `postgresql://standin:${standIn.password}@127.0.0.1:${standIn.port}/postgres`;
    const folder = (name: string) => path.join(standIn.work, "backups", name);
    const backup = (dir: string, databaseUrl = url, args: string[] = []) => {
      if (!databaseUrl.includes("@127.0.0.1:") || !dir.startsWith(standIn.work)) throw new Error("the eval only ever backs up its stand-in, into its own folder");
      return script(BACKUP, args, { ...childEnv(process.env, { PG_BIN: bin }), DATABASE_URL: databaseUrl, BACKUP_DIR: dir });
    };
    const restoreTest = (archive: string, extra: Record<string, string> = {}, onLine?: (line: string) => void) =>
      script(RESTORE_TEST, [archive], { ...childEnv(process.env, { PG_BIN: bin }), ...extra }, onLine);
    const log = path.join(standIn.work, "server.log");

    // F5 and F6: both of the backup's connections are encrypted, and the
    // backup and its restore test pass, named a backup only then (F4).
    const a = folder("a");
    let logFrom = fs.statSync(log).size;
    const baseline = await backup(a);
    const connections = fs.readFileSync(log, "utf8").slice(logFrom).split("\n").filter((l) => /connection authorized: user=standin/.test(l));
    const archive = backupsIn(a).find((f) => f.endsWith(".dump"));
    check(
      "a backup passes, and only then is named .dump, beside its manifest",
      baseline.code === 0 && backupsIn(a).length === 2 && archive !== undefined && /PASS: /.test(baseline.out),
      `exit ${baseline.code}; files ${backupsIn(a).join(", ")}\n${tail(baseline.out)}`,
    );
    if (!archive) return false;
    const first = manifestOf(a, archive);
    check(
      "its manifest records every table's definition and the restore test's pass (F3, F9)",
      first.schema !== null &&
        first.schema.length === first.tables.length &&
        first.schema.every((t) => t.definition.some((l) => l.startsWith("column "))) &&
        ["index ", "constraint ", "table: "].every((kind) => first.schema!.some((t) => t.definition.some((l) => l.startsWith(kind)))) &&
        first.restoreTests.length === 1 &&
        first.restoreTests[0]!.passed,
      JSON.stringify({ schema: first.schema?.map((t) => [t.name, t.definition.length]), restoreTests: first.restoreTests }),
    );
    check(
      "both of its connections to the database are encrypted, the measuring one and pg_dump's (F5, F6)",
      connections.length === 2 && connections.every((l) => / SSL enabled /.test(l)) && connections.some((l) => /application_name=cyclingdataapp-backup/.test(l)),
      connections.join("\n") || "no connection in the stand-in's log",
    );

    // F5's guard: a URL asking for no TLS is refused before any query.
    const plain = await backup(folder("plain"), `${url}?sslmode=disable`);
    check(
      "a database address that turns TLS off is refused, and nothing is written (F5)",
      plain.code === 1 && /not encrypted/.test(plain.out) && backupsIn(folder("plain")).length === 0,
      `exit ${plain.code}; files ${backupsIn(folder("plain")).join(", ")}\n${tail(plain.out)}`,
    );

    // F2: a ride saving while the backup runs. One fix committed every 50ms,
    // the backup started once three have landed (or 30s pass, or the writer
    // fails, both of which fail the check: no write landed during it).
    let writerError = "";
    const writer = run(psql, ["-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(standIn.port), "-U", "standin", "-d", "postgres", "-q", "-c",
      `do $$ declare s bigint; begin select max(id) into s from public.sessions;
         for i in 1..1200 loop
           insert into public.session_samples (session_id, recorded_at, lat, lon, elevation_m) values (s, clock_timestamp(), 38.8, -104.8, 1840);
           commit; perform pg_sleep(0.05);
         end loop; end $$`], { ...tools, PGAPPNAME: "eval-writer" }, 120_000).catch((err: Error) => {
      writerError = err.message;
    });
    const fixesBefore = Number(await sql("select count(*) from public.session_samples"));
    const writing = Date.now() + 30_000;
    while (!writerError && Date.now() < writing && Number(await sql("select count(*) from public.session_samples")) < fixesBefore + 3) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const writerFailed = writerError; // after this the writer is stopped on purpose, which it reports as an error too
    const b = folder("b");
    const during = await backup(b);
    await sql("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'eval-writer'");
    await writer;
    const duringArchive = backupsIn(b).find((f) => f.endsWith(".dump"));
    const samples = duringArchive ? manifestOf(b, duringArchive).sequences.find((s) => s.name === "session_samples_id_seq") : undefined;
    check(
      "a backup taken while a ride saves passes, its sequence ahead of the rows it holds (F2)",
      during.code === 0 && samples !== undefined && samples.lastValue !== null && samples.columnMax != null && samples.lastValue > samples.columnMax,
      `exit ${during.code}; files ${backupsIn(b).join(", ")}; session_samples_id_seq ${JSON.stringify(samples)}${writerFailed ? `\nthe ride writer failed before the backup: ${writerFailed}` : ""}\n${tail(during.out)}`,
    );

    // F9: the shell's libpq settings reach neither the restore test's own
    // connection nor its tools, and a second result joins the first.
    const again = await restoreTest(path.join(a, archive), { PGSSLMODE: "require", PGOPTIONS: "-c statement_timeout=1", PGHOST: "nowhere.invalid" });
    const history = manifestOf(a, archive).restoreTests;
    check(
      "a restore test run from a shell with PGSSLMODE=require, PGOPTIONS and PGHOST set passes, its result kept beside the first (F9)",
      again.code === 0 && history.length === 2 && history.every((t) => t.passed),
      `exit ${again.code}; history ${JSON.stringify(history.map((t) => t.passed))}\n${tail(again.out)}`,
    );

    // F4: a backup whose restore test fails is named .dump.failed, and the
    // default archive stays the newest that passed. The restore fails on a
    // policy for a role the throwaway does not have.
    await sql("create role eval_reader", "create policy eval_only on public.sessions to eval_reader using (true)");
    const failing = await backup(a);
    await sql("drop policy eval_only on public.sessions", "drop role eval_reader");
    const failedFiles = backupsIn(a).filter((f) => f !== archive && f !== `${archive}.json`);
    check(
      "a backup whose restore test fails is kept as .dump.failed, with its manifest, and is not the default (F4)",
      failing.code === 1 && failedFiles.length === 2 && failedFiles.every((f) => /\.dump\.failed(\.json)?$/.test(f)) && defaultArchive(a) === archive,
      `exit ${failing.code}; files ${backupsIn(a).join(", ")}; default ${defaultArchive(a)}\n${tail(failing.out)}`,
    );

    // F8: a restore test killed outright leaves its server behind its
    // password, and the next restore test removes it.
    let killed: { work: string; port: string } | null = null;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", RESTORE_TEST, path.join(a, archive)], {
        cwd: BACKEND,
        env: childEnv(process.env, { PG_BIN: bin }),
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
        const up = /a throwaway PostgreSQL in (.+), on 127\.0\.0\.1:(\d+)$/.exec(line);
        if (up && !killed) {
          killed = { work: up[1]!, port: up[2]! };
          child.kill();
        }
      });
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    const left = killed as { work: string; port: string } | null;
    if (!left) {
      check("a restore test killed outright leaves nothing readable, and the next one removes it (F8)", false, "the restore test never said its server was up");
    } else {
      const noPassword = { ...childEnv(process.env, {}), PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "5" };
      const login = await run(psql, ["-X", "-w", "-h", "127.0.0.1", "-p", left.port, "-U", "restore_test", "-d", "postgres", "-Atc", "select count(*) from public.sessions"], noPassword, 30_000).then(
        (out) => `read without a password: ${out.trim()}`,
        (err: Error) => err.message,
      );
      const next = await restoreTest(path.join(a, archive));
      const after = await run(psql, ["-X", "-w", "-h", "127.0.0.1", "-p", left.port, "-U", "restore_test", "-d", "postgres", "-Atc", "select 1"], noPassword, 30_000).then(
        () => "still answering",
        (err: Error) => err.message,
      );
      check(
        "a restore test killed outright leaves nothing readable without its password, and the next one stops its server and deletes its folder (F8)",
        /password/.test(login) && next.code === 0 && next.out.includes(`its owner gone: ${left.work}`) && !fs.existsSync(left.work) && !/still answering/.test(after),
        `after the kill: ${login}\nnext restore test: exit ${next.code}, folder ${fs.existsSync(left.work) ? "still there" : "gone"}; port ${left.port}: ${after}\n${tail(next.out)}`,
      );
    }

    // --no-restore-test leaves an archive untested, and a restore test of it
    // later names it a backup.
    const e = folder("e");
    const skipped = await backup(e, url, ["--no-restore-test"]);
    const untested = backupsIn(e).find((f) => f.endsWith(".dump.untested"));
    const tested = untested ? await restoreTest(path.join(e, untested)) : null;
    check(
      "--no-restore-test leaves .dump.untested, and a restore test of it later renames it .dump (F4)",
      skipped.code === 0 && /UNTESTED: /.test(skipped.out) && untested !== undefined && tested?.code === 0 && backupsIn(e).join() === [untested.replace(/\.untested$/, ""), `${untested.replace(/\.untested$/, "")}.json`].join(),
      `exit ${skipped.code}, then ${tested?.code}; files ${backupsIn(e).join(", ")}\n${tail(skipped.out, 4)}`,
    );

    // F1: a table the last backup held, gone now, fails, unless --dropped says it went on purpose.
    await sql("create table public.eval_scratch (id int primary key)", "insert into public.eval_scratch values (1)");
    const withScratch = await backup(e);
    await sql("drop table public.eval_scratch");
    const gone = await backup(e);
    const acknowledged = await backup(e, url, ["--dropped=eval_scratch"]);
    check(
      "a table the last backup held, gone now, fails the next backup, and --dropped=<table> lets it through (F1)",
      withScratch.code === 0 && gone.code === 1 && /eval_scratch: in the last backup \(cyclingdataapp-.+\.dump\) and gone now; if it was dropped on purpose, run with --dropped=eval_scratch/.test(gone.out) && acknowledged.code === 0,
      `exits ${withScratch.code}, ${gone.code}, ${acknowledged.code}\n${tail(gone.out, 4)}`,
    );

    // F1: an app table outside public, then every app table moved out of it
    // (last: it leaves the stand-in with no app tables in public).
    const d = folder("d");
    await sql("create schema private", "create table private.ride_notes (id bigserial primary key, session_id bigint not null references public.sessions(id), note text not null)", "insert into private.ride_notes (session_id, note) select id, 'note' from public.sessions");
    const outside = await backup(d);
    check(
      "a database with an app table outside public is not backed up, and says which (F1)",
      outside.code === 1 && /schema private holds tables this backup does not copy \(it copies public only\): ride_notes/.test(outside.out) && backupsIn(d).length === 0,
      `exit ${outside.code}; files ${backupsIn(d).join(", ")}\n${tail(outside.out)}`,
    );
    await sql("drop schema private cascade");
    await sql("create schema app", "do $$ declare t text; begin for t in select tablename from pg_tables where schemaname = 'public' and tablename <> 'spatial_ref_sys' loop execute format('alter table public.%I set schema app', t); end loop; end $$");
    const filesBefore = backupsIn(a).length;
    const moved = await backup(a);
    check(
      "a database whose app tables all left public is not backed up: no tables, schema.sql's missing, schema app named (F1)",
      moved.code === 1 && /public holds no app tables/.test(moved.out) && /sessions: schema\.sql creates it/.test(moved.out) && /schema app holds tables/.test(moved.out) && backupsIn(a).length === filesBefore,
      `exit ${moved.code}\n${tail(moved.out)}`,
    );
  } finally {
    for (const problem of await standIn.stop()) console.error(`stand-in: ${problem}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed} of ${checks.length} checks pass`);
  return failed === 0;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
