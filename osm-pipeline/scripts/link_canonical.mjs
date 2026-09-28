import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { buildLinkPlan, decide, tally, writesFor, MIN_FRONTAGE } from "./lib/linkPlan.mjs";
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
// Hancock Expressway that turns a corner: 41m east along the cross street, then
// 102m south along Hancock. Its chord missed Hancock's by 20.6 degrees, so it
// stayed canonical, competed with Hancock for the rider's GPS fixes, and left a
// 191m hole in a road that was ridden end to end.
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
const apply = process.argv.includes("--apply");
const unfold = process.argv.includes("--unfold");
const reparent = process.argv.includes("--reparent");

const BATCH = 1000;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
await client.query("set statement_timeout = '10min'");

const outDir = path.join(os.tmpdir(), "link_canonical");
fs.mkdirSync(outDir, { recursive: true });

try {
  console.log(
    `frontage rule: >= ${(MIN_FRONTAGE * 100).toFixed(0)}% of a path within ` +
      `${MAX_OFFSET_M}m of a road and within ${MAX_TANGENT_DELTA_DEG} degrees of its local heading`,
  );
  console.log(
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
  const decided = decide(plan, MIN_FRONTAGE);
  const t = tally(decided);
  console.log(`\r  measured ${plan.length} eligible paths in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // What the chosen policy would actually write. `writesFor` is tested.
  const writes = writesFor(decided, { unfold, reparent });
  const target = (d) => d.writeParent;
  const folds = writes.filter((d) => d.action === "fold");
  const releases = writes.filter((d) => d.action === "release");
  const reparents = writes.filter((d) => d.action === "reparent");

  console.log("frontage says:");
  console.log(`  ${String(t.fold).padStart(6)} canonical paths should be folded`);
  console.log(`  ${String(t.unfold).padStart(6)} folded paths no longer qualify  ${unfold ? "(will be released)" : "(kept folded; pass --unfold to release)"}`);
  console.log(`  ${String(t.reparent).padStart(6)} folded paths belong to a different road  ${reparent ? "(will be rewritten)" : "(left alone; pass --reparent to rewrite)"}`);
  console.log(`  ${String(t.unchanged).padStart(6)} unchanged\n`);
  console.log(`this run would write ${writes.length} rows: ${folds.length} folds, ${reparents.length} reparents, ${releases.length} releases`);
  console.log("  (only a fold or a release changes what the map draws -- every reader");
  console.log("   of canonical_segment_id tests it for null and none reads its value)\n");

  // A named line losing segments is the failure mode this script has already
  // caused once, so it is checked on every run rather than trusted to the name
  // rule. Anything whose own name says "sidewalk" is the rule working.
  const namedFolds = folds.filter((d) => d.streetName !== null);
  const unintended = namedFolds.filter((d) => !/sidewalk/i.test(d.streetName));
  console.log(`named lines losing segments: ${namedFolds.length}, all of which should say "sidewalk"`);
  for (const d of namedFolds) console.log(`  #${String(d.id).padStart(6)} ${d.streetName}`);
  if (unintended.length > 0) {
    // Not reachable while eligibility is `street_name is null or ilike
    // '%sidewalk%'`, which is the same predicate -- so this is a tripwire on
    // the eligibility clause, not on the geometry, and it is written to THROW
    // rather than print. A warning nobody can trigger printing beside a list
    // that always passes is the kind of reassurance this project has learned to
    // distrust; if it ever fires, it means the name rule that protects Shooks
    // Run and the Greenway has been loosened, and the run should stop.
    throw new Error(
      `eligibility has changed: ${unintended.length} named path(s) would fold whose name is ` +
        `not a sidewalk, e.g. #${unintended[0].id} "${unintended[0].streetName}". ` +
        `The name rule is what protects Shooks Run, Midland and the Pikes Peak Greenway.`,
    );
  }

  // Frontage is pooled across every nearby road, so a path can clear the gate
  // without any one street holding much of it. 337 of the 345 that need the
  // pool run along streets that physically meet -- corner pavements -- but the
  // ones where no road holds even a third are worth an eye.
  const thin = folds.filter((d) => d.parentFrontage < 0.35).sort((a, b) => a.parentFrontage - b.parentFrontage);
  console.log(`\nfolds where no single road holds a third of the path: ${thin.length}`);
  for (const d of thin.slice(0, 8)) {
    console.log(
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
  console.log(`\ncurrently-drawn lines that would stop being drawn: ${drawn.length}`);
  for (const r of drawn) {
    console.log(
      `  #${String(r.id).padStart(6)} ${String(r.street_name ?? "(unnamed)").padEnd(22)} ` +
        `${r.kind.padEnd(8)} tagged_sidewalk=${String(r.is_sidewalk).padEnd(5)} ` +
        `${String(r.len).padStart(4)}m  ${String(r.buckets).padStart(3)} buckets`,
    );
  }

  // The full diff, every run, applied or not. A net count hides which lines
  // moved, and this script's one historical failure was visible only per-line.
  const csv = path.join(outDir, `plan-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
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
            target(d) ?? "",
            d.currentParent === null ? "fold" : target(d) === null ? "release" : "reparent",
          ].join(","),
        )
        .join("\n") + "\n",
  );
  console.log(`\nfull per-line diff: ${csv}`);

  if (!apply) {
    console.log("\ndry run -- nothing written. Re-run with --apply.");
  } else {
    // The snapshot is what makes this reversible: id and the parent it had
    // before, for every row about to move.
    const snapshot = path.join(outDir, `before-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    fs.writeFileSync(
      snapshot,
      "id,canonical_segment_id\n" +
        writes.map((d) => `${d.id},${d.currentParent ?? ""}`).join("\n") + "\n",
    );
    console.log(`snapshot of the ${writes.length} rows about to change: ${snapshot}`);

    await client.query("begin");
    let written = 0;
    for (let i = 0; i < writes.length; i += BATCH) {
      const batch = writes.slice(i, i + BATCH);
      const values = [];
      const tuples = batch.map((d, j) => {
        values.push(d.id, target(d));
        return `($${j * 2 + 1}::bigint, $${j * 2 + 2}::bigint)`;
      });
      const { rowCount } = await client.query(
        `update segments s set canonical_segment_id = v.parent
           from (values ${tuples.join(", ")}) as v(id, parent)
          where s.id = v.id`,
        values,
      );
      written += rowCount;
      process.stdout.write(`\r  wrote ${written}/${writes.length}`);
    }
    // Before the commit, not after: if the UPDATE matched fewer rows than the
    // plan named, some segment vanished between the read and the write and the
    // half-applied result is worse than none.
    if (written !== writes.length) {
      throw new Error(
        `planned ${writes.length} rows but the UPDATE matched ${written}; rolling back`,
      );
    }
    await client.query("commit");
    console.log(`\nwrote ${written} rows`);
  }

  const { rows: summary } = await client.query(
    `select kind, is_sidewalk,
            count(*) filter (where canonical_segment_id is null) as canonical,
            count(*) filter (where canonical_segment_id is not null) as merged_into_road
       from segments group by kind, is_sidewalk order by kind, is_sidewalk`,
  );
  console.log("");
  console.table(summary);

  if (apply) {
    console.log("Segment geometry is unchanged, but which lines are match candidates is not.");
    console.log("Run `npm run rebuild-model` in backend/ before trusting the map.");
  }
} catch (err) {
  await client.query("rollback").catch(() => {});
  throw err;
} finally {
  client.release();
  await pool.end();
}
