// The threshold-and-classify half of the linker, which is pure and needs no
// database. buildLinkPlan itself is exercised against the live network by the
// script's dry run; what is worth pinning down here is that a measurement
// turns into the right verdict, because that is what decides whether a line
// disappears off the map.

import test from "node:test";
import assert from "node:assert/strict";
import { decide, tally, eligibleSql } from "./linkPlan.mjs";

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

test("eligibility does not read is_sidewalk, and that is deliberate", () => {
  // A few stretches of named trail are tagged footway=sidewalk in OSM --
  // Midland Trail, Vindicator Drive Trail, Homestead Trail. The name is what
  // protects them, so the tag must not be allowed to override it.
  assert.ok(!eligibleSql("f").includes("is_sidewalk"));
});
