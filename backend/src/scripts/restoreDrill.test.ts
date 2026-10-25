import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest, RestoreTest } from "./backupFormat.js";
import { newestArchive, recordResult } from "./restoreDrill.js";

// What a restore test does to the files it is given: its result joins the
// manifest's history, and archive and manifest are renamed together to what
// that history makes them, so a file's name says whether it is a backup. And
// which archive a restore test, or a backup's "last backup" check, takes by
// default. On real files in a temp folder; no database. Last, that the eval
// (evalBackup.ts) judges the restore against a production built without it.

const DUMP = "cyclingdataapp-2026-10-25T16-55-26Z.dump";
const result = (passed: boolean, sha256 = "good"): RestoreTest => ({ passed, at: "2026-10-25T17:00:00.000Z", problems: passed ? [] : ["x"], seconds: 5, sha256 });
const manifest = (file: string, restoreTests: RestoreTest[] = []): Manifest => ({
  file,
  createdAt: "2026-10-25T16:55:26.305Z",
  server: { version: "17.6", postgis: "3.3.7" },
  pgDump: "pg_dump (PostgreSQL) 17.11",
  bytes: 7,
  sha256: "good",
  tables: [{ name: "sessions", rows: 52, fingerprint: "aa" }],
  schema: [{ name: "sessions", definition: ["table: row security off, logged"] }],
  sequences: [{ name: "sessions_id_seq", lastValue: 89, columnMax: 89 }],
  restoreTests,
});

function folder(files: Record<string, Manifest | string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-drill-test-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  return dir;
}
const read = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Manifest;
const names = (dir: string) => fs.readdirSync(dir).sort();

test("an untested archive that passes becomes a .dump, its manifest renamed with it, saying its new name and the result", (t) => {
  const dir = folder({ [`${DUMP}.untested`]: "archive", [`${DUMP}.untested.json`]: manifest(`${DUMP}.untested`) });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = recordResult(path.join(dir, `${DUMP}.untested`), manifest(`${DUMP}.untested`), result(true));
  assert.equal(now, path.join(dir, DUMP));
  assert.deepEqual(names(dir), [DUMP, `${DUMP}.json`]);
  assert.equal(fs.readFileSync(path.join(dir, DUMP), "utf8"), "archive", "the same bytes, moved");
  assert.equal(read(dir, `${DUMP}.json`).file, DUMP);
  assert.deepEqual(read(dir, `${DUMP}.json`).restoreTests, [result(true)]);
});

test("an untested archive that fails becomes .dump.failed, never a backup's name", (t) => {
  const dir = folder({ [`${DUMP}.untested`]: "archive", [`${DUMP}.untested.json`]: manifest(`${DUMP}.untested`) });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  recordResult(path.join(dir, `${DUMP}.untested`), manifest(`${DUMP}.untested`), result(false));
  assert.deepEqual(names(dir), [`${DUMP}.failed`, `${DUMP}.failed.json`]);
  assert.equal(read(dir, `${DUMP}.failed.json`).file, `${DUMP}.failed`);
});

test("a backup that fails a later test, its bytes unchanged, stays a backup, the failure kept in its history beside the pass", (t) => {
  const before = manifest(DUMP, [result(true)]);
  const dir = folder({ [DUMP]: "archive", [`${DUMP}.json`]: before });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  recordResult(path.join(dir, DUMP), before, result(false));
  assert.deepEqual(names(dir), [DUMP, `${DUMP}.json`]);
  assert.deepEqual(read(dir, `${DUMP}.json`).restoreTests, [result(true), result(false)], "the review's F9: an environment failure overwrote a recorded pass");
});

test("a backup whose bytes have changed since it passed is no longer one", (t) => {
  const before = manifest(DUMP, [result(true)]);
  const dir = folder({ [DUMP]: "archive", [`${DUMP}.json`]: before });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  recordResult(path.join(dir, DUMP), before, result(false, "changed"));
  assert.deepEqual(names(dir), [`${DUMP}.failed`, `${DUMP}.failed.json`]);
});

test("a failed archive that passes later is a backup", (t) => {
  const before = manifest(`${DUMP}.failed`, [result(false)]);
  const dir = folder({ [`${DUMP}.failed`]: "archive", [`${DUMP}.failed.json`]: before });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  recordResult(path.join(dir, `${DUMP}.failed`), before, result(true));
  assert.deepEqual(names(dir), [DUMP, `${DUMP}.json`]);
});

test("a name already taken is not overwritten: the archive keeps its own, its result recorded there", (t) => {
  const dir = folder({ [`${DUMP}.untested`]: "archive", [`${DUMP}.untested.json`]: manifest(`${DUMP}.untested`), [DUMP]: "another" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(recordResult(path.join(dir, `${DUMP}.untested`), manifest(`${DUMP}.untested`), result(true)), path.join(dir, `${DUMP}.untested`));
  assert.equal(fs.readFileSync(path.join(dir, DUMP), "utf8"), "another");
  assert.deepEqual(read(dir, `${DUMP}.untested.json`).restoreTests, [result(true)]);
});

test("the default archive is the newest .dump whose manifest says it passed: never an untested or failed one", (t) => {
  const at = (hh: string) => `cyclingdataapp-2026-10-25T${hh}-00-00Z.dump`;
  const legacy = { ...manifest(at("10")), restoreTests: undefined, restoreTest: result(true) };
  const dir = folder({
    [at("10")]: "a",
    [`${at("10")}.json`]: legacy as unknown as Manifest,
    [at("11")]: "b",
    [`${at("11")}.json`]: manifest(at("11"), [result(true)]),
    [at("12")]: "c",
    [`${at("12")}.json`]: manifest(at("12"), [result(false)]),
    [at("13")]: "d",
    [`${at("14")}.untested`]: "e",
    [`${at("14")}.untested.json`]: manifest(`${at("14")}.untested`),
    [`${at("15")}.failed`]: "f",
    [`${at("15")}.failed.json`]: manifest(`${at("15")}.failed`, [result(false)]),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(newestArchive(dir), path.join(dir, at("11")), "12 failed (written by the code before its renaming), 13 has no manifest, 14 and 15 are not backups");
  fs.rmSync(path.join(dir, at("11")));
  fs.rmSync(path.join(dir, `${at("11")}.json`));
  assert.equal(newestArchive(dir), path.join(dir, at("10")), "a manifest from before the history counts its one pass");
  assert.throws(() => newestArchive(path.join(dir, "none")), /no backup in/);
});

test("the eval builds its stand-in for production without restorableList, the restore filter it judges", () => {
  // 2026-10-25: built with it, the stand-in lost every index a widened
  // filter dropped, the restore test's copy matched it, and the mutant passed.
  const source = fs.readFileSync(fileURLToPath(new URL("./evalBackup.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /import\s*\{[^}]*\brestorableList\b[^}]*\}/, "imported");
  assert.doesNotMatch(source, /\brestorableList\(/, "called");
});
