// The script, driven against a fake client.
//
// This file exists because three cold reviews in a row found the same thing:
// the defect moves to whichever file the tests cannot reach. Round three's
// critical finding was that `npm test` globbed `scripts/lib/*.test.mjs` and
// link_canonical.mjs is not in lib/, so EIGHT single-line edits there survived
// all 81 tests. Five of them restore the bug the whole change exists to fix.
// Each one below names the edit it kills.
//
// Free and deterministic: no database, no filesystem outside a temp dir, no
// clock. `runLink` takes its client, its argv, its log and its clock.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLink } from "./link_canonical.mjs";
import { SEG_23278, HANCOCK_17973, HANCOCK_17974, TRANSIT_4847 } from "./lib/fixtures.mjs";

const M_LAT = 111132.0;
const M_LON = 111320.0 * Math.cos((38.82 * Math.PI) / 180);
const at = (e, n) => [-104.8 + e / M_LON, 38.82 + n / M_LAT];

const asRoad = (r, name, a, b) => ({
  id: r.id, gj: JSON.stringify({ coordinates: r.coords }), name, a, b,
});

/**
 * A client that serves one page of candidates and records every statement.
 *
 * Four paths, chosen so that every branch of the script is reachable:
 *
 *   #11     runs alongside a road, canonical      -> folds
 *   #12     crosses it, canonical                 -> untouched
 *   #23278  the real reference segment, canonical -> folds, at frontage 0.9031
 *   #14     crosses it, ALREADY folded            -> only --unfold releases it
 *
 * #23278 carries its real geometry rather than a synthetic stand-in, because a
 * mutation that filters the plan at 0.95 before the rule sees it survives any
 * fixture that scores higher than that. And #14 exists so that forcing
 * `unfold: true` has something to release; without it that mutation is
 * invisible.
 */
function fakeClient({ rowCount = null } = {}) {
  const statements = [];
  const plain = {
    id: 900,
    gj: JSON.stringify({ coordinates: [at(0, 0), at(200, 0)] }),
    name: "Plain Street",
    a: "n1",
    b: "n2",
  };
  // Transit Drive meets Hancock #17973 at the corner; #17973 meets #17974.
  const hancockSet = [
    asRoad(TRANSIT_4847, "Transit Drive", "t1", "corner"),
    asRoad(HANCOCK_17973, "Hancock Expressway", "corner", "h2"),
    asRoad(HANCOCK_17974, "Hancock Expressway", "h2", "h3"),
  ];
  let served = false;
  return {
    statements,
    async query(text, values) {
      statements.push({ text: String(text).trim().split("\n")[0].trim(), values });
      if (/^begin|^commit|^rollback|^set /i.test(String(text).trim())) return { rows: [] };
      if (/segment_elevation_buckets/.test(text)) return { rows: [] };
      if (/group by kind/.test(text)) return { rows: [] };
      if (/update segments/i.test(text)) {
        return { rowCount: rowCount ?? values.length / 2 };
      }
      if (served) return { rows: [] };
      served = true;
      return {
        rows: [
          {
            id: "11", kind: "footway", is_sidewalk: true, street_name: null,
            length_m: 140, canonical_segment_id: null,
            path_gj: JSON.stringify({ coordinates: [at(10, 8), at(150, 8)] }),
            roads: [plain],
          },
          {
            id: "12", kind: "footway", is_sidewalk: true, street_name: null,
            length_m: 60, canonical_segment_id: null,
            path_gj: JSON.stringify({ coordinates: [at(100, -30), at(100, 30)] }),
            roads: [plain],
          },
          {
            id: "23278", kind: "footway", is_sidewalk: true, street_name: null,
            length_m: 146, canonical_segment_id: null,
            path_gj: JSON.stringify({ coordinates: SEG_23278 }),
            roads: hancockSet,
          },
          {
            id: "14", kind: "footway", is_sidewalk: true, street_name: null,
            length_m: 60, canonical_segment_id: "900",
            path_gj: JSON.stringify({ coordinates: [at(140, -30), at(140, 30)] }),
            roads: [plain],
          },
        ],
      };
    },
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "linktest-"));
const silent = () => {};
const clock = () => new Date("2026-01-01T00:00:00.000Z");
const run = (client, argv, dir) =>
  runLink(client, { argv, log: silent, outDir: dir ?? tmp(), now: clock });

const updates = (c) => c.statements.filter((s) => /^update segments/i.test(s.text));
const verbs = (c) => c.statements.filter((s) => /^(begin|commit|rollback)$/i.test(s.text)).map((s) => s.text.toLowerCase());

// ------------------------------------------------------------ the dry run

test("a bare run writes nothing at all", async () => {
  // Kills: `if (!apply)` inverted, which makes `npm run link` with no arguments
  // write to production and `--apply` report a dry run.
  const client = fakeClient();
  const out = await run(client, []);
  assert.equal(out.apply, false);
  assert.equal(out.applied, 0);
  assert.equal(updates(client).length, 0, "no UPDATE may be issued without --apply");
  assert.deepEqual(verbs(client), [], "and no transaction may even be opened");
});

test("a dry run still produces the plan, so the numbers can be read before writing", async () => {
  const client = fakeClient();
  const out = await run(client, []);
  assert.deepEqual(out.writes.map((w) => w.id).sort((a, b) => a - b), [11, 23278]);
  for (const w of out.writes) assert.equal(w.action, "fold");
});

test("THE REFERENCE: #23278 folds into Hancock, through the script, end to end", async () => {
  // The whole change exists for this segment. Its real frontage is 0.9031, so
  // any edit that filters or gates the plan above that -- the shape round two
  // found in `decide(plan, 0.95)` and round three found again as a filter on
  // the plan itself -- puts Hancock's 91m hole back.
  const client = fakeClient();
  const out = await run(client, ["--apply"]);
  const w = out.writes.find((x) => x.id === 23278);
  assert.ok(w, "#23278 must be in the write set");
  assert.equal(w.action, "fold");
  assert.equal(w.writeParent, 17973, "the Hancock piece holding the largest share");
  const wrote = updates(client).flatMap((u) => u.values);
  assert.ok(wrote.includes(23278), "and it must actually reach the database");
});

// --------------------------------------------------------------- --apply

test("--apply writes inside a transaction and commits", async () => {
  // Kills: `commit` swapped for `rollback`, which prints "wrote N rows" and
  // lands nothing.
  const client = fakeClient();
  const out = await run(client, ["--apply"]);
  assert.equal(out.apply, true);
  assert.equal(out.applied, 2);
  assert.deepEqual(verbs(client), ["begin", "commit"]);
  assert.equal(updates(client).length, 1, "one batched statement, not one per row");
});

test("--apply writes the FOLDS, not a filtered subset of them", async () => {
  // Kills: `applyWrites(client, writes.filter(w => w.action !== "fold"))`,
  // which leaves every hole exactly where it was while reporting success.
  const client = fakeClient();
  await run(client, ["--apply"]);
  const [u] = updates(client);
  assert.deepEqual(u.values, [11, 900, 23278, 17973], "both folding paths and their parents, in order");
});

test("--apply keys the update on the path and sets the parent", async () => {
  // Kills: the two values swapped, which repoints a road at a segment.
  const client = fakeClient();
  await run(client, ["--apply"]);
  const [u] = updates(client);
  assert.equal(u.values[0], 11, "path id first");
  assert.equal(u.values[1], 900, "parent second");
  assert.notEqual(u.values[0], u.values[1], "and never a path onto itself");
});

test("the path that crosses the road is never written", async () => {
  const client = fakeClient();
  await run(client, ["--apply"]);
  for (const u of updates(client)) {
    assert.ok(!u.values.includes(12), "#12 crosses the road and must stay canonical");
  }
});

// ------------------------------------------------------------ the failures

test("a short write refuses to commit", async () => {
  // Kills: deleting the rowcount check, or deleting `throw err` from the catch,
  // either of which commits or swallows a half-applied fold.
  const client = fakeClient({ rowCount: 0 });
  await assert.rejects(() => run(client, ["--apply"]), /planned 2 rows but the UPDATE matched 0/);
  assert.ok(!verbs(client).includes("commit"), "a shortfall must never reach commit");
});

test("the error from a short write escapes the function", async () => {
  // A caller that sees no exception has no reason to roll back.
  const client = fakeClient({ rowCount: 0 });
  let threw = false;
  try {
    await run(client, ["--apply"]);
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
});

// ------------------------------------------------------------- the flags

test("--unfold and --reparent are not implied by --apply", async () => {
  // Kills: `planRun(plan, { unfold: true, reparent })` hardcoded, which
  // releases 743 live paths and costs Brenner Place its line.
  //
  // #14 in the fixture is already folded and no longer qualifies, so it is
  // exactly what a forced --unfold would release. Without such a row in the
  // fixture this test cannot fail, however it is written.
  const client = fakeClient();
  const out = await run(client, ["--apply"]);
  for (const w of out.writes) {
    assert.notEqual(w.action, "release", "nothing may be released without --unfold");
    assert.notEqual(w.action, "reparent", "nothing may be reparented without --reparent");
  }
  assert.ok(!out.writes.some((w) => w.id === 14), "#14 stays folded");
});

test("--unfold does release it, so the fixture really can show the difference", async () => {
  // The control for the test above: if #14 could never be released by anything,
  // the assertion that it was not released proves nothing.
  const client = fakeClient();
  const out = await run(client, ["--apply", "--unfold"]);
  const released = out.writes.find((w) => w.id === 14);
  assert.ok(released, "#14 must be releasable");
  assert.equal(released.action, "release");
  assert.equal(released.writeParent, null);
});

// -------------------------------------------------------------- the files

test("both runs write a per-line diff, and only --apply writes a snapshot", async () => {
  const dryDir = tmp();
  await run(fakeClient(), [], dryDir);
  const dry = fs.readdirSync(dryDir);
  assert.equal(dry.filter((f) => f.startsWith("plan-")).length, 1);
  assert.equal(dry.filter((f) => f.startsWith("before-")).length, 0, "nothing to reverse");

  const applyDir = tmp();
  await run(fakeClient(), ["--apply"], applyDir);
  const applied = fs.readdirSync(applyDir);
  assert.equal(applied.filter((f) => f.startsWith("plan-")).length, 1);
  assert.equal(applied.filter((f) => f.startsWith("before-")).length, 1, "the reversal record");
});

test("the snapshot records the parent each row had BEFORE the write", async () => {
  // It is the only thing that makes --apply reversible, so it has to hold the
  // old value, not the new one.
  const dir = tmp();
  await run(fakeClient(), ["--apply"], dir);
  const snap = fs.readdirSync(dir).find((f) => f.startsWith("before-"));
  const body = fs.readFileSync(path.join(dir, snap), "utf8").trim().split("\n");
  assert.equal(body[0], "id,canonical_segment_id");
  assert.equal(body[1], "11,", "#11 was canonical, so its previous parent is empty");
  assert.ok(!body[1].includes("900"), "the snapshot must not hold the new parent");
});

test("the per-line diff names the action and both parents", async () => {
  const dir = tmp();
  await run(fakeClient(), [], dir);
  const plan = fs.readdirSync(dir).find((f) => f.startsWith("plan-"));
  const body = fs.readFileSync(path.join(dir, plan), "utf8").trim().split("\n");
  assert.equal(body[0], "id,kind,is_sidewalk,street_name,length_m,frontage,current_parent,new_parent,action");
  assert.match(body[1], /^11,footway,true,"",/);
  assert.match(body[1], /,,900,fold$/, "empty old parent, new parent 900, action fold");
});

// ------------------------------------------------- the named-trail tripwire

test("a named path that is not a sidewalk stops the run", async () => {
  // Kills: `if (false)` on the unintended check. This is the guard on the rule
  // that protects Shooks Run, Midland and the Pikes Peak Greenway, and it has
  // to stop the run rather than print a warning nobody reads.
  const client = fakeClient();
  const inner = client.query.bind(client);
  client.query = async (text, values) => {
    const res = await inner(text, values);
    for (const r of res.rows ?? []) if (r.id === "11") r.street_name = "Shooks Run Trail";
    return res;
  };
  await assert.rejects(() => run(client, ["--apply"]), /eligibility has changed/);
  assert.equal(updates(client).length, 0, "and it must stop BEFORE writing anything");
});
