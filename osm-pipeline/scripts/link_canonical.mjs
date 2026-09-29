import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { pathToFileURL } from "node:url";
import {
  buildLinkPlan,
  planRun,
  applyWrites,
  parseFlags,
  MIN_FRONTAGE,
} from "./lib/linkPlan.mjs";
import { MAX_OFFSET_M, MAX_TANGENT_DELTA_DEG } from "./lib/frontage.mjs";

// Points every sidewalk segment at the road it runs alongside, so the matcher
// and the map treat a street and its pavements as one route.
//
// Run after load_segments.mjs and prune_orphans.mjs.
//
// ELIGIBILITY IS BY NAME, and that has not changed. Proximity on its own is not
// enough: trails such as Shooks Run, Midland and the Pikes Peak Greenway run
// beside a road for part of their length, and an early purely geometric pass
// absorbed just those stretches and cut them into disconnected pieces -- Shooks
// Run lost 57 segments, Midland 35, the Greenway 10. Every trail it ate was
// named, so the name test alone is what protects them. A path qualifies if OSM
// tags it footway=sidewalk, or if nobody named it at all: a path that hugs a
// street for its whole length without earning a name is a pavement whatever its
// tags say.
//
// WHAT CHANGED is how "runs alongside" is decided. It used to compare
// `bearing_deg` -- the straight line from a segment's first point to its last --
// against the road's, within 20 degrees. That is the chord, and the chord is
// meaningless on anything that bends. Segment #23278 is one 146m footway beside
// Hancock Expressway that turns a corner: 30m east along Transit Drive, a 14m
// corner radius, then 102m south along Hancock. Its chord missed Hancock's by
// 20.6 degrees, so it stayed canonical, competed with Hancock for the rider's
// GPS fixes, and left Hancock #17973 with 0m of its 91m drawn -- half of the
// 191m hole in session.md, the other half having been closed earlier by the
// connectivity change.
//
// Now each path is walked in 5m steps and asked, at every step, whether a road
// is within MAX_OFFSET_M and heading the same way *here*. The fraction of its
// length that answers yes is its frontage. See scripts/lib/frontage.mjs; the
// geometry is unit tested without a database.
//
// Measured on the live network, 2026-09-27, over the 42 sessions the model
// uses, by replaying the real matcher and gate against both candidate sets:
//
//                impossible  buckets  covered_km  road_km  lines
//   before             8.2%    14711      225.06    55.14    750
//   after              7.1%    14710      225.10    55.37    749
//
//   Hancock #17973 went from 0m of 91m covered to 90m, which is the hole
//   closing. Three pavement lines stopped being drawn -- all three tagged
//   footway=sidewalk, unnamed, and sitting 0-7m from their street -- and two
//   pieces of Hancock started being drawn instead.
//
// Dry run unless --apply is passed.
//
//   DATABASE_URL=... node scripts/link_canonical.mjs
//   DATABASE_URL=... node scripts/link_canonical.mjs --apply

// MIN_FRONTAGE, plannedParent() and the candidate query all live in
// lib/linkPlan.mjs, where tests can reach them. They were here, and every one
// of them was invisible to the suite: raising the threshold to 0.95 puts the
// Hancock hole back with all 46 tests green.
//
// Both flags default off, for opposite reasons -- releasing can regress a road,
// re-parenting is inert. See plannedParent().
/**
 * One run of the linker, with its world injected so a test can drive it.
 *
 * This exists because the test suite could not reach a line of this file, and
 * a cold review found eight single-line edits here that survived all 81 tests.
 * Among them: inverting the `if (!apply)` branch, so a bare run writes to
 * production while `--apply` reports a dry run; swapping `commit` for
 * `rollback` while still printing "wrote 745 rows"; and filtering the folds out
 * of the write so #23278 stays canonical and Hancock keeps its hole.
 *
 * Returns what it did, so a caller can assert on the outcome rather than on
 * stdout.
 */
export async function runLink(client, { argv = [], log = console.log, outDir, now = () => new Date() } = {}) {
  const { apply, unfold, reparent } = parseFlags(argv);
  log(
    `frontage rule: >= ${(MIN_FRONTAGE * 100).toFixed(0)}% of a path within ` +
      `${MAX_OFFSET_M}m of a road and within ${MAX_TANGENT_DELTA_DEG} degrees of its local heading`,
  );
  log(
    `policy: fold${unfold ? " + release (--unfold)" : ""}${reparent ? " + reparent (--reparent)" : ""}` +
      `${unfold || reparent ? "" : " only -- nothing already folded is released or moved"}\n`,
  );

  const t0 = Date.now();
  let lastLog = 0;
  const plan = await buildLinkPlan(client, {
    onProgress: (n) => {
      if (n - lastLog >= 5000) {
        lastLog = n;
        process.stdout.write(`\r  measured ${n} paths`);
      }
    },
  });
  log(`\r  measured ${plan.length} eligible paths in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Every decision is made in planRun, which is tested. This script passes no
  // threshold and applies no rule of its own -- it prints and it writes.
  const run = planRun(plan, { unfold, reparent });
  const { counts: t, writes, folds, releases, reparents, namedFolds, unintended, thin } = run;


  log("frontage says:");
  log(`  ${String(t.fold).padStart(6)} canonical paths should be folded`);
  log(`  ${String(t.unfold).padStart(6)} folded paths no longer qualify  ${unfold ? "(will be released)" : "(kept folded; pass --unfold to release)"}`);
  log(`  ${String(t.reparent).padStart(6)} folded paths belong to a different road  ${reparent ? "(will be rewritten)" : "(left alone; pass --reparent to rewrite)"}`);
  log(`  ${String(t.unchanged).padStart(6)} unchanged\n`);
  log(`this run would write ${writes.length} rows: ${folds.length} folds, ${reparents.length} reparents, ${releases.length} releases`);
  log("  (only a fold or a release changes what the map draws -- every reader");
  log("   of canonical_segment_id tests it for null and none reads its value)\n");

  log(`named lines losing segments: ${namedFolds.length}, all of which should say "sidewalk"`);
  for (const d of namedFolds) log(`  #${String(d.id).padStart(6)} ${d.streetName}`);
  if (unintended.length > 0) {
    throw new Error(
      `eligibility has changed: ${unintended.length} named path(s) would fold whose name is ` +
        `not a sidewalk, e.g. #${unintended[0].id} "${unintended[0].streetName}". ` +
        `The name rule is what protects Shooks Run, Midland and the Pikes Peak Greenway.`,
    );
  }

  // Frontage pools across every nearby road, and MIN_BEST_STREET_FRONTAGE puts
  // a floor under that. These cleared the floor -- they are alongside one
  // connected run of street -- but no single road holds much of any of them, so
  // they are where the argument is thinnest. Listed in FULL rather than
  // sampled, because a printed count of 15 above a list of 8 is the kind of
  // half-report this file has already shipped once.
  log(`\nfolds where no single road holds a third of the path: ${thin.length}`);
  for (const d of thin) {
    log(
      `  #${String(d.id).padStart(6)} ${String(Math.round(d.lengthM)).padStart(4)}m  ` +
        `frontage ${d.frontage.toFixed(2)} pooled over ${d.roadsNearby} roads, ` +
        `best single ${d.parentFrontage.toFixed(2)}`,
    );
  }

  // Anything currently drawing a line on the map, because that is what a rider
  // would notice disappearing.
  const foldIds = folds.map((d) => d.id);
  const { rows: drawn } = foldIds.length
    ? await client.query(
        `select s.id, s.street_name, s.kind, s.is_sidewalk, round(s.length_m::numeric,0) as len,
                count(b.*)::int as buckets
           from segments s join segment_elevation_buckets b on b.segment_id = s.id
          where s.id = any($1)
          group by s.id, s.street_name, s.kind, s.is_sidewalk, s.length_m
          order by buckets desc`,
        [foldIds],
      )
    : { rows: [] };
  log(`\ncurrently-drawn lines that would stop being drawn: ${drawn.length}`);
  for (const r of drawn) {
    log(
      `  #${String(r.id).padStart(6)} ${String(r.street_name ?? "(unnamed)").padEnd(22)} ` +
        `${r.kind.padEnd(8)} tagged_sidewalk=${String(r.is_sidewalk).padEnd(5)} ` +
        `${String(r.len).padStart(4)}m  ${String(r.buckets).padStart(3)} buckets`,
    );
  }

  // The full diff, every run, applied or not. A net count hides which lines
  // moved, and this script's one historical failure was visible only per-line.
  const csv = path.join(outDir, `plan-${now().toISOString().replace(/[:.]/g, "-")}.csv`);
  fs.writeFileSync(
    csv,
    "id,kind,is_sidewalk,street_name,length_m,frontage,current_parent,new_parent,action\n" +
      writes
        .map((d) =>
          [
            d.id,
            d.kind,
            d.isSidewalk,
            JSON.stringify(d.streetName ?? ""),
            d.lengthM.toFixed(1),
            d.frontage.toFixed(4),
            d.currentParent ?? "",
            d.writeParent ?? "",
            d.action,
          ].join(","),
        )
        .join("\n") + "\n",
  );
  log(`\nfull per-line diff: ${csv}`);

  if (!apply) {
    log("\ndry run -- nothing written. Re-run with --apply.");
  } else {
    // The snapshot is what makes this reversible: id and the parent it had
    // before, for every row about to move.
    const snapshot = path.join(outDir, `before-${now().toISOString().replace(/[:.]/g, "-")}.csv`);
    fs.writeFileSync(
      snapshot,
      "id,canonical_segment_id\n" +
        writes.map((d) => `${d.id},${d.currentParent ?? ""}`).join("\n") + "\n",
    );
    log(`snapshot of the ${writes.length} rows about to change: ${snapshot}`);

    await client.query("begin");
    // applyWrites batches, checks the row count and throws on a shortfall, all
    // of it tested. This loop used to live here as a hand-copied duplicate of
    // updateBatch, which meant updateBatch's tests guarded a function with no
    // callers while the statement that reaches production had none at all.
    const written = await applyWrites(client, writes, {
      onProgress: (n, total) => process.stdout.write(`\r  wrote ${n}/${total}`),
    });
    await client.query("commit");
    log(`\nwrote ${written} rows`);
  }

  const { rows: summary } = await client.query(
    `select kind, is_sidewalk,
            count(*) filter (where canonical_segment_id is null) as canonical,
            count(*) filter (where canonical_segment_id is not null) as merged_into_road
       from segments group by kind, is_sidewalk order by kind, is_sidewalk`,
  );
  log("");
  log(summary);

  if (apply) {
    log("Segment geometry is unchanged, but which lines are match candidates is not.");
    log("Run `npm run rebuild-model` in backend/ before trusting the map.");
  }
  return { apply, writes, applied: apply ? writes.length : 0 };
}

// Only when run as a script, so importing this file for a test connects to
// nothing.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  await client.query("set statement_timeout = '10min'");
  const dir = path.join(os.tmpdir(), "link_canonical");
  fs.mkdirSync(dir, { recursive: true });
  try {
    await runLink(client, { argv: process.argv, outDir: dir });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}
