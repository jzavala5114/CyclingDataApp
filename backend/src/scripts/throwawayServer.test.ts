import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isStale, processAlive, removeWork, sweepStale, WORK_PREFIX } from "./throwawayServer.js";

// The throwaway server's folders hold a copy of every ride while it runs, so
// what deletes them, and what counts as left behind, is pinned here. Starting
// a real server is the restore test's and the eval's work (npm run
// backup:restore-test, npm run eval:backup).

/** A process number that was running a moment ago and is not now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

test("a throwaway deletes its own folder and nothing else", () => {
  const tmp = path.resolve(os.tmpdir());
  for (const victim of [tmp, path.join(tmp, "other"), path.resolve("/"), path.join(tmp, "..", `${WORK_PREFIX}x`), path.join(tmp, "cyclingdataapp-restore-test-x")]) {
    assert.throws(() => removeWork(victim, tmp), /refusing to delete/, victim);
  }
});

test("a folder is stale once the process that made it is gone, or, with no owner on record, once it is a minute old", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "throwaway-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const make = (name: string, owner?: string) => {
    const work = path.join(tmp, `${WORK_PREFIX}${name}`);
    fs.mkdirSync(work);
    if (owner !== undefined) fs.writeFileSync(path.join(work, "owner.pid"), owner);
    return work;
  };
  assert.ok(processAlive(process.pid));
  const dead = deadPid();
  assert.ok(!processAlive(dead), `process ${dead} has exited`);

  const mine = make("mine", String(process.pid));
  const orphan = make("orphan", String(dead));
  const garbled = make("garbled", "not a number");
  const fresh = make("fresh");
  assert.equal(isStale(mine), false, "its owner, this process, runs");
  assert.equal(isStale(orphan), true);
  assert.equal(isStale(garbled), true);
  assert.equal(isStale(fresh), false, "an owner may be about to write its file");
  assert.equal(isStale(fresh, Date.now() + 61_000), true);

  // The sweep removes the stale ones only. None has a server running
  // (no postmaster.pid), so pg_ctl is never called: a missing one proves it.
  const swept = sweepStale(path.join(tmp, "no-pg_ctl.exe"), tmp);
  assert.deepEqual(swept.sort(), [garbled, orphan].sort());
  assert.ok(fs.existsSync(mine) && fs.existsSync(fresh));
  assert.ok(!fs.existsSync(orphan) && !fs.existsSync(garbled));
});
