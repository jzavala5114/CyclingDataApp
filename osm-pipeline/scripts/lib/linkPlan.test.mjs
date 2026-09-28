// The threshold-and-classify half of the linker, which is pure and needs no
// database. buildLinkPlan itself is exercised against the live network by the
// script's dry run; what is worth pinning down here is that a measurement
// turns into the right verdict, because that is what decides whether a line
// disappears off the map.

import test from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  tally,
  eligibleSql,
  plannedParent,
  writesFor,
  updateBatch,
  parseFlags,
  candidateQuery,
  buildLinkPlan,
  planRun,
  applyWrites,
  CANDIDATE_SQL,
  MIN_FRONTAGE,
  PREFILTER_DEG,
  prefilterReachM,
} from "./linkPlan.mjs";
import { measureFrontage, MAX_OFFSET_M } from "./frontage.mjs";
import { SEG_23278, HANCOCK_17973, HANCOCK_17974, TRANSIT_4847 } from "./fixtures.mjs";

const row = (over) => ({
  id: 1,
  kind: "footway",
  isSidewalk: true,
  streetName: null,
  lengthM: 100,
  currentParent: null,
  frontage: 0,
  parentId: null,
  parentFrontage: 0,
  roadsNearby: 0,
  ...over,
});

test("a canonical path that clears the threshold is a fold", () => {
  const [d] = decide([row({ currentParent: null, frontage: 0.9, parentId: 55 })], 0.6);
  assert.equal(d.change, "fold");
  assert.equal(d.newParent, 55);
});

test("a folded path that no longer clears the threshold is an unfold", () => {
  const [d] = decide([row({ currentParent: 55, frontage: 0.2, parentId: 55 })], 0.6);
  assert.equal(d.change, "unfold");
  assert.equal(d.newParent, null);
});

test("a folded path that now belongs to a different road is a reparent", () => {
  const [d] = decide([row({ currentParent: 55, frontage: 0.9, parentId: 77 })], 0.6);
  assert.equal(d.change, "reparent");
  assert.equal(d.newParent, 77);
});

test("a folded path that still belongs to the same road is unchanged", () => {
  const [d] = decide([row({ currentParent: 55, frontage: 0.9, parentId: 55 })], 0.6);
  assert.equal(d.change, "unchanged");
});

test("a canonical path below the threshold is unchanged, not an unfold", () => {
  const [d] = decide([row({ currentParent: null, frontage: 0.1, parentId: 55 })], 0.6);
  assert.equal(d.change, "unchanged");
  assert.equal(d.newParent, null);
});

test("the threshold is inclusive", () => {
  assert.equal(decide([row({ frontage: 0.6, parentId: 9 })], 0.6)[0].change, "fold");
  assert.equal(decide([row({ frontage: 0.5999, parentId: 9 })], 0.6)[0].change, "unchanged");
});

test("clearing the threshold with no road to point at folds nowhere", () => {
  // Reachable only if minFrontage is 0; frontage above 0 always has a parent.
  const [d] = decide([row({ frontage: 0, parentId: null })], 0);
  assert.equal(d.newParent, null);
  assert.equal(d.change, "unchanged");
});

test("decide does not mutate the plan it is given", () => {
  const plan = [row({ currentParent: 55, frontage: 0.9, parentId: 77 })];
  const before = JSON.stringify(plan);
  decide(plan, 0.6);
  assert.equal(JSON.stringify(plan), before);
});

test("every path lands in exactly one bucket", () => {
  const plan = [
    row({ id: 1, currentParent: null, frontage: 0.9, parentId: 5 }),
    row({ id: 2, currentParent: 5, frontage: 0.1, parentId: 5 }),
    row({ id: 3, currentParent: 5, frontage: 0.9, parentId: 7 }),
    row({ id: 4, currentParent: 5, frontage: 0.9, parentId: 5 }),
    row({ id: 5, currentParent: null, frontage: 0.1, parentId: 5 }),
  ];
  const t = tally(decide(plan, 0.6));
  assert.deepEqual(t, { total: 5, fold: 1, unfold: 1, reparent: 1, unchanged: 2 });
  assert.equal(t.fold + t.unfold + t.reparent + t.unchanged, t.total);
});

test("eligibility is by name and qualifies every column, on either alias", () => {
  // The unqualified version made `street_name` ambiguous the moment the query
  // joined roads, which is how this was found.
  for (const alias of ["f", "s"]) {
    const sql = eligibleSql(alias);
    assert.ok(sql.includes(`${alias}.kind in ('footway','cycleway')`));
    assert.ok(sql.includes(`${alias}.street_name is null`));
    assert.ok(sql.includes(`${alias}.street_name ilike '%sidewalk%'`));
    // Every mention of a column must be a qualified one. An unqualified
    // `street_name` parses fine on its own and only fails once the query joins
    // a second copy of `segments`, which is exactly how it got shipped.
    for (const col of ["kind", "street_name"]) {
      const all = sql.split(col).length - 1;
      const qualified = sql.split(`${alias}.${col}`).length - 1;
      assert.equal(qualified, all, `${col} appears unqualified in eligibleSql("${alias}")`);
    }
  }
});

// ------------------------------------------------- the threshold, pinned
//
// MIN_FRONTAGE is the single number that decides whether a line disappears off
// the map, and until these tests existed nothing could see it: as a private
// constant in link_canonical.mjs, raising it to 0.95 restored the Hancock hole
// with the whole suite green.

test("THE GATE: MIN_FRONTAGE folds #23278, the segment this rewrite exists for", () => {
  const m = measureFrontage(SEG_23278, [TRANSIT_4847, HANCOCK_17973, HANCOCK_17974]);
  assert.ok(
    m.frontage >= MIN_FRONTAGE,
    `#23278 measures ${m.frontage.toFixed(4)} and the gate is ${MIN_FRONTAGE}; ` +
      `at this threshold Hancock #17973 keeps its 91m hole`,
  );
  const [d] = decide(
    [{ id: 23278, currentParent: null, frontage: m.frontage, parentId: m.parentId }],
    MIN_FRONTAGE,
  );
  assert.equal(d.change, "fold");
  assert.equal(d.newParent, 17973);
});

test("THE GATE: and it still rejects a cycleway that only clips a road", () => {
  // The gate has to be low enough to admit #23278 and high enough to refuse
  // this. Pinning both ends is what stops it being moved in either direction.
  const m = measureFrontage(
    [[-104.7489689, 38.9294584], [-104.750385816, 38.930115115]],
    [{
      id: 47223,
      coords: [
        [-104.748407353, 38.929845794], [-104.748538, 38.9297187],
        [-104.7486577, 38.9296081], [-104.7488512, 38.9294074],
        [-104.74946571, 38.928803514],
      ],
    }],
  );
  assert.ok(m.frontage < MIN_FRONTAGE, `#52602 measures ${m.frontage.toFixed(4)}`);
});

test("MIN_FRONTAGE sits inside the plateau the sweep measured", () => {
  // 0.5, 0.6 and 0.7 gave identical buckets, coverage and impossible rates
  // through the full matcher. A value outside that range was never measured.
  assert.ok(MIN_FRONTAGE >= 0.5 && MIN_FRONTAGE <= 0.7, `MIN_FRONTAGE is ${MIN_FRONTAGE}`);
});

test("the bbox prefilter reaches further than the offset limit it prefilters for", () => {
  // If PREFILTER_DEG ever shrinks below MAX_OFFSET_M the bbox stops being a
  // prefilter and silently becomes the filter, dropping real candidates with
  // no error anywhere.
  assert.ok(
    prefilterReachM() > MAX_OFFSET_M,
    `prefilter reaches ${prefilterReachM().toFixed(1)}m but the offset limit is ${MAX_OFFSET_M}m`,
  );
  assert.ok(PREFILTER_DEG > 0);
});

// --------------------------------------------- the write policy, pinned
//
// plannedParent is the last step between a measurement and a row in the
// database. As a closure inside link_canonical.mjs, all three of the mutations
// named in each test below survived the suite.

const folded = { id: 7, currentParent: 55, newParent: null, frontage: 0.2 };
const moved = { id: 8, currentParent: 55, newParent: 77, frontage: 0.9 };
const fresh = { id: 9, currentParent: null, newParent: 55, frontage: 0.9 };

test("by default a fold is written and nothing else is", () => {
  assert.equal(plannedParent(fresh), 55);
  assert.equal(plannedParent(folded), 55, "a path that no longer qualifies stays folded");
  assert.equal(plannedParent(moved), 55, "a better parent is not written");
});

test("--unfold releases, and only with the flag", () => {
  assert.equal(plannedParent(folded, { unfold: true }), null);
  assert.equal(plannedParent(folded, { unfold: false }), 55);
  // If --unfold were ever the default, 743 live paths would be released and
  // Brenner Place #37523 would lose its line.
  assert.notEqual(plannedParent(folded), null, "--unfold must not be the default");
});

test("--reparent moves an already-folded path, and only with the flag", () => {
  assert.equal(plannedParent(moved, { reparent: true }), 77);
  assert.equal(plannedParent(moved, { reparent: false }), 55);
  assert.notEqual(plannedParent(moved), 77, "--reparent must not be the default");
});

test("a path is never made its own parent", () => {
  for (const opts of [{}, { unfold: true }, { reparent: true }, { unfold: true, reparent: true }]) {
    for (const d of [folded, moved, fresh, { id: 3, currentParent: null, newParent: null }]) {
      assert.notEqual(plannedParent(d, opts), d.id, `#${d.id} became its own parent`);
    }
  }
});

test("writesFor emits only rows that change, labelled with what they are", () => {
  const decided = [fresh, folded, moved, { id: 10, currentParent: 55, newParent: 55 }];
  const plain = writesFor(decided);
  assert.deepEqual(plain.map((w) => [w.id, w.action, w.writeParent]), [[9, "fold", 55]]);

  const all = writesFor(decided, { unfold: true, reparent: true });
  assert.deepEqual(all.map((w) => [w.id, w.action, w.writeParent]), [
    [9, "fold", 55],
    [7, "release", null],
    [8, "reparent", 77],
  ]);
  for (const w of all) assert.notEqual(w.writeParent, w.currentParent);
});

test("the UPDATE keys on the path id and sets the parent, not the other way round", () => {
  const { sql, values } = updateBatch([
    { id: 101, writeParent: 900 },
    { id: 102, writeParent: null },
  ]);
  // id first, parent second, in every pair. Swapping them survived the suite
  // and would have repointed roads at segments.
  assert.deepEqual(values, [101, 900, 102, null]);
  assert.match(sql, /set canonical_segment_id = v\.parent/);
  assert.match(sql, /where s\.id = v\.id/);
  assert.doesNotMatch(sql, /set canonical_segment_id = v\.id/);
  assert.doesNotMatch(sql, /where s\.id = v\.parent/);
});

test("the UPDATE casts both columns, so an all-null batch still joins", () => {
  // Without ::bigint an all-NULL column in a VALUES list is typed text and the
  // join fails -- which is exactly what --unfold produces.
  const { sql, values } = updateBatch([{ id: 7, writeParent: null }, { id: 8, writeParent: null }]);
  assert.match(sql, /\(\$1::bigint, \$2::bigint\)/);
  assert.match(sql, /\(\$3::bigint, \$4::bigint\)/);
  assert.deepEqual(values, [7, null, 8, null]);
});

test("the UPDATE's placeholders match the values it carries", () => {
  const batch = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, writeParent: 500 + i }));
  const { sql, values } = updateBatch(batch);
  assert.equal(values.length, 80);
  const highest = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.equal(highest, values.length, "a placeholder with no value is a runtime error");
  assert.equal(sql.match(/\$\d+::bigint/g).length, 80);
});

// ------------------------------------------------------- the candidate query

test("GOLDEN: the candidate query is exactly this, character for character", () => {
  // Substring assertions do not work here and the earlier ones did not: a test
  // for /order by f\.id/ passes `order by f.id desc`, which makes the keyset
  // cursor read the top page forever and never reach #23278; a test that the
  // eligibility clause `includes` its three fragments passes the version with
  // `or` changed to `and`, which makes nothing eligible at all. Both edits are
  // one character and both left 62 tests green.
  //
  // So pin the whole string. Changing the query deliberately means changing
  // this literal, which is the point: this query decides what is hidden from
  // the map, and no edit to it should be able to arrive unannounced.
  const expected = `
  select f.id,
         f.kind,
         f.is_sidewalk,
         f.street_name,
         f.length_m,
         f.canonical_segment_id,
         ST_AsGeoJSON(f.geom) as path_gj,
         coalesce(
           json_agg(json_build_object('id', r.id, 'gj', ST_AsGeoJSON(r.geom)))
             filter (where r.id is not null),
           '[]'
         ) as roads
    from segments f
    left join segments r
      on r.kind = 'road'
     and r.geom && ST_Expand(f.geom, $2)
     and ST_DWithin(f.geom::geography, r.geom::geography, $3)
   where f.kind in ('footway','cycleway')
   and (f.street_name is null or f.street_name ilike '%sidewalk%')
     and f.id > $1
   group by f.id
   order by f.id
   limit $4`;
  assert.equal(CANDIDATE_SQL, expected);
});

test("the candidate query's parameters are bound in the order its placeholders expect", () => {
  // $2 feeds ST_Expand on a 4326 geometry, so DEGREES. $3 feeds ST_DWithin on
  // geography, so METRES. Swapping them leaves every path with no candidate
  // roads and every frontage at 0, and an assertion about the constants
  // themselves cannot see it.
  const { text, values } = candidateQuery(12345, 500);
  assert.equal(text, CANDIDATE_SQL);
  assert.deepEqual(values, [12345, PREFILTER_DEG, MAX_OFFSET_M, 500]);
  assert.ok(values[1] < 1, "$2 is a degree value");
  assert.ok(values[2] > 1, "$3 is a metre value");
});

test("the candidate query keeps the four clauses that decide correctness", () => {
  // None of these is reachable from a database-free test, and each one silently
  // survived the suite as a mutation: a path folding into another path, the
  // distance test dropped so the bbox becomes the filter, eligibility widened,
  // and pagination re-reading or skipping rows.
  assert.match(CANDIDATE_SQL, /r\.kind = 'road'/, "a path must not fold into another path");
  assert.match(CANDIDATE_SQL, /ST_DWithin\(f\.geom::geography, r\.geom::geography, \$3\)/);
  assert.match(CANDIDATE_SQL, /ST_Expand\(f\.geom, \$2\)/, "the bbox prefilter the GiST index serves");
  assert.ok(CANDIDATE_SQL.includes(eligibleSql("f")), "eligibility is the shared clause");
});

test("the candidate query pages by keyset, so no row is read twice or skipped", () => {
  // Strictly-greater against the last id seen, ordered by that same id, with a
  // limit. `>=` would re-read the boundary row forever; ordering by anything
  // else would make the cursor meaningless.
  assert.match(CANDIDATE_SQL, /f\.id > \$1/);
  assert.match(CANDIDATE_SQL, /order by f\.id/);
  assert.match(CANDIDATE_SQL, /limit \$4/);
  assert.doesNotMatch(CANDIDATE_SQL, /f\.id >= \$1/);
});

// ------------------------------------- buildLinkPlan, against a fake client
//
// `buildLinkPlan` had no test of any kind, and the pagination loop is where a
// silent edit does the most damage: `order by f.id desc` reads the top page
// forever, taking `rows[0]` instead of the last re-reads it, an unconditional
// break reads one page. None of those throws; they just quietly measure a
// fraction of the network and fold a fraction of what they should.

/** Stands in for a Postgres client over a table of ids, honouring the query. */
function fakeClient(ids, { order = "asc" } = {}) {
  const calls = [];
  const sorted = [...ids].sort((a, b) => (order === "asc" ? a - b : b - a));
  return {
    calls,
    async query(text, values) {
      calls.push(values);
      const [after, , , limit] = values;
      // Mirror `where f.id > $1 order by f.id limit $4`.
      const page = sorted.filter((id) => (order === "asc" ? id > after : id < after)).slice(0, limit);
      return {
        rows: page.map((id) => ({
          id: String(id),
          kind: "footway",
          is_sidewalk: true,
          street_name: null,
          length_m: 50,
          canonical_segment_id: null,
          // Straight 50m path with no road nearby: frontage 0, which is fine --
          // these tests are about which ROWS are read, not about geometry.
          path_gj: JSON.stringify({ coordinates: [[-104.8, 38.82], [-104.8, 38.8205]] }),
          roads: [],
        })),
      };
    },
  };
}

test("buildLinkPlan maps each row's own values, not a constant", async () => {
  // The fake rows above are deliberately uniform, which is exactly why they
  // could not catch `frontage: 1` or `currentParent: null` hardcoded into the
  // mapping. These rows differ from each other in every field that matters.
  const M_LAT = 111132.0;
  const M_LON = 111320.0 * Math.cos((38.82 * Math.PI) / 180);
  const at = (e, n) => [-104.8 + e / M_LON, 38.82 + n / M_LAT];
  const road = { id: 900, gj: JSON.stringify({ coordinates: [at(0, 0), at(200, 0)] }) };

  const rows = [
    // Runs alongside the road at 8m: full frontage, and already folded.
    { id: "11", canonical_segment_id: "900", coords: [at(10, 8), at(150, 8)], roads: [road] },
    // Crosses it: no frontage, still canonical.
    { id: "12", canonical_segment_id: null, coords: [at(100, -30), at(100, 30)], roads: [road] },
    // Nowhere near anything.
    { id: "13", canonical_segment_id: null, coords: [at(0, 400), at(100, 400)], roads: [] },
  ];
  let served = false;
  const client = {
    async query() {
      if (served) return { rows: [] };
      served = true;
      return {
        rows: rows.map((r) => ({
          id: r.id,
          kind: "footway",
          is_sidewalk: true,
          street_name: null,
          length_m: 140,
          canonical_segment_id: r.canonical_segment_id,
          path_gj: JSON.stringify({ coordinates: r.coords }),
          roads: r.roads,
        })),
      };
    },
  };

  const plan = await buildLinkPlan(client, { batchSize: 500 });
  assert.equal(plan.length, 3);

  // Frontage must come from measureFrontage on that row's own geometry.
  assert.ok(plan[0].frontage > 0.999, `alongside: ${plan[0].frontage}`);
  assert.equal(plan[1].frontage, 0, "crossing must not report frontage");
  assert.equal(plan[2].frontage, 0, "no roads, no frontage");
  assert.equal(plan[0].parentId, 900);
  assert.equal(plan[1].parentId, null);
  assert.equal(plan[2].roadsNearby, 0);
  assert.equal(plan[0].roadsNearby, 1);

  // And currentParent must come from the column, not be assumed null.
  assert.equal(plan[0].currentParent, 900, "an already-folded path must not read as canonical");
  assert.equal(plan[1].currentParent, null);
  assert.equal(typeof plan[0].currentParent, "number", "bigint arrives as a string and must be coerced");
  assert.equal(plan[0].id, 11);
  assert.equal(typeof plan[0].id, "number");
});

test("buildLinkPlan's default page size actually fetches rows", async () => {
  // Every other test passes batchSize explicitly, so `BATCH = 0` -- `limit 0`,
  // an always-empty plan, no error anywhere -- went unnoticed.
  const ids = [1, 2, 3, 4, 5];
  const client = fakeClient(ids);
  const plan = await buildLinkPlan(client); // no batchSize
  assert.equal(plan.length, ids.length, "the default page size must not be zero");
  assert.ok(client.calls[0][3] >= 100, `default limit is ${client.calls[0][3]}`);
});

test("buildLinkPlan reads every row exactly once", async () => {
  const ids = Array.from({ length: 1200 }, (_, i) => i * 7 + 5852);
  const client = fakeClient(ids);
  const plan = await buildLinkPlan(client, { batchSize: 500 });
  assert.equal(plan.length, ids.length, "every row measured");
  assert.deepEqual(new Set(plan.map((p) => p.id)).size, ids.length, "and none measured twice");
  assert.deepEqual(plan.map((p) => p.id), ids, "in id order");
  // 500 + 500 + 200: the short page ends it, so no wasted empty query.
  assert.equal(client.calls.length, 3);
});

test("buildLinkPlan ends cleanly on an exact multiple of the page size", async () => {
  const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
  const client = fakeClient(ids);
  const plan = await buildLinkPlan(client, { batchSize: 500 });
  assert.equal(plan.length, 1000);
  // Two full pages, then one empty page to learn there is no more.
  assert.equal(client.calls.length, 3);
});

test("buildLinkPlan on an empty table returns an empty plan and asks once", async () => {
  const client = fakeClient([]);
  assert.deepEqual(await buildLinkPlan(client, { batchSize: 500 }), []);
  assert.equal(client.calls.length, 1);
});

test("buildLinkPlan advances its cursor past the page it just read", async () => {
  const ids = [10, 20, 30, 40, 50];
  const client = fakeClient(ids);
  await buildLinkPlan(client, { batchSize: 2 });
  // -1, then the LAST id of each page: pages are [10,20], [30,40], [50], and
  // the short final page ends the loop without another query. Taking rows[0]
  // instead would give -1, 10, 20, ... and re-read most of the table.
  assert.deepEqual(client.calls.map((c) => c[0]), [-1, 20, 40]);
});

test("buildLinkPlan carries the page size into the query, so it cannot page by zero", async () => {
  const client = fakeClient([1, 2, 3]);
  await buildLinkPlan(client, { batchSize: 2 });
  for (const call of client.calls) assert.equal(call[3], 2);
});

// -------------------------------------------------- planRun and applyWrites

test("a bare run writes nothing, releases nothing and moves nothing", () => {
  // The default matters more than any flag: `npm run link` with no arguments is
  // what a reader tries first, and it must be a dry run that cannot regress a
  // road or inflate the write eightfold.
  assert.deepEqual(parseFlags([]), { apply: false, unfold: false, reparent: false });
  assert.deepEqual(parseFlags(["node", "scripts/link_canonical.mjs"]), {
    apply: false, unfold: false, reparent: false,
  });
});

test("each flag turns on exactly itself", () => {
  assert.deepEqual(parseFlags(["--apply"]), { apply: true, unfold: false, reparent: false });
  assert.deepEqual(parseFlags(["--unfold"]), { apply: false, unfold: true, reparent: false });
  assert.deepEqual(parseFlags(["--reparent"]), { apply: false, unfold: false, reparent: true });
  assert.deepEqual(parseFlags(["--apply", "--unfold", "--reparent"]), {
    apply: true, unfold: true, reparent: true,
  });
  // Asking to write must not also ask to release.
  assert.equal(parseFlags(["--apply"]).unfold, false);
});

test("an unrecognised argument turns nothing on", () => {
  for (const argv of [["--dry-run"], ["--APPLY"], ["apply"], ["-a"], ["--apply-all"], [""]]) {
    const f = parseFlags(argv);
    assert.equal(f.apply, false, `${argv} must not enable --apply`);
    assert.equal(f.unfold, false);
    assert.equal(f.reparent, false);
  }
});

test("planRun applies MIN_FRONTAGE itself, so no caller passes a threshold", () => {
  const just = planRun([row({ id: 1, frontage: MIN_FRONTAGE + 0.001, parentId: 5 })]);
  assert.equal(just.folds.length, 1);
  const shy = planRun([row({ id: 1, frontage: MIN_FRONTAGE - 0.001, parentId: 5 })]);
  assert.equal(shy.folds.length, 0);
});

test("planRun folds #23278 with the real geometry, end to end", () => {
  const m = measureFrontage(SEG_23278, [TRANSIT_4847, HANCOCK_17973, HANCOCK_17974]);
  const out = planRun([row({ id: 23278, frontage: m.frontage, parentId: m.parentId, currentParent: null })]);
  assert.equal(out.folds.length, 1);
  assert.equal(out.writes[0].writeParent, 17973);
  assert.equal(out.writes[0].action, "fold");
});

test("planRun separates the named folds, the unintended ones and the thin ones", () => {
  const out = planRun([
    row({ id: 1, frontage: 0.9, parentId: 5, streetName: "Elm Street sidewalk", parentFrontage: 0.9 }),
    row({ id: 2, frontage: 0.9, parentId: 5, streetName: "Shooks Run Trail", parentFrontage: 0.9 }),
    row({ id: 3, frontage: 0.9, parentId: 5, streetName: null, parentFrontage: 0.2 }),
  ]);
  assert.deepEqual(out.namedFolds.map((f) => f.id), [1, 2]);
  assert.deepEqual(out.unintended.map((f) => f.id), [2], "a named trail folding must be caught");
  assert.deepEqual(out.thin.map((f) => f.id), [3]);
});

test("planRun defaults to folds only", () => {
  const out = planRun([
    row({ id: 1, currentParent: null, frontage: 0.9, parentId: 5 }),
    row({ id: 2, currentParent: 55, frontage: 0.1, parentId: 55 }),
    row({ id: 3, currentParent: 55, frontage: 0.9, parentId: 77 }),
  ]);
  assert.deepEqual(out.writes.map((w) => w.action), ["fold"]);
  const both = planRun(
    [
      row({ id: 1, currentParent: null, frontage: 0.9, parentId: 5 }),
      row({ id: 2, currentParent: 55, frontage: 0.1, parentId: 55 }),
      row({ id: 3, currentParent: 55, frontage: 0.9, parentId: 77 }),
    ],
    { unfold: true, reparent: true },
  );
  assert.deepEqual(both.writes.map((w) => w.action).sort(), ["fold", "release", "reparent"]);
});

test("applyWrites batches through updateBatch and counts what the database matched", async () => {
  const seen = [];
  const client = { async query(sql, values) { seen.push({ sql, values }); return { rowCount: values.length / 2 }; } };
  const writes = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, writeParent: 900 + i }));
  assert.equal(await applyWrites(client, writes, { batchSize: 100 }), 250);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((s) => s.values.length), [200, 200, 100]);
  // Same statement the tested updateBatch produces, not a copy of it.
  assert.equal(seen[0].sql, updateBatch(writes.slice(0, 100)).sql);
  assert.deepEqual(seen[0].values, updateBatch(writes.slice(0, 100)).values);
});

test("applyWrites throws rather than returning short, so the caller can roll back", async () => {
  // A segment deleted between the read and the write. A half-applied fold is
  // worse than none, so this must not return quietly.
  const client = { async query() { return { rowCount: 1 }; } };
  await assert.rejects(
    () => applyWrites(client, [{ id: 1, writeParent: 2 }, { id: 3, writeParent: 4 }], { batchSize: 10 }),
    /planned 2 rows but the UPDATE matched 1/,
  );
});

test("applyWrites on an empty plan issues no statement at all", async () => {
  let called = 0;
  const client = { async query() { called++; return { rowCount: 0 }; } };
  assert.equal(await applyWrites(client, [], { batchSize: 10 }), 0);
  assert.equal(called, 0);
});

test("eligibility does not read is_sidewalk, and that is deliberate", () => {
  // A few stretches of named trail are tagged footway=sidewalk in OSM --
  // Midland Trail, Vindicator Drive Trail, Homestead Trail. The name is what
  // protects them, so the tag must not be allowed to override it.
  assert.ok(!eligibleSql("f").includes("is_sidewalk"));
});
