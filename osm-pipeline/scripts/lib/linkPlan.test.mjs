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

test("eligibility does not read is_sidewalk, and that is deliberate", () => {
  // A few stretches of named trail are tagged footway=sidewalk in OSM --
  // Midland Trail, Vindicator Drive Trail, Homestead Trail. The name is what
  // protects them, so the tag must not be allowed to override it.
  assert.ok(!eligibleSql("f").includes("is_sidewalk"));
});
