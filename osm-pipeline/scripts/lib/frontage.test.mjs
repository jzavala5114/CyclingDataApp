// Run with: npm test (osm-pipeline), or node --test scripts/lib/
//
// Free, deterministic, no database. Every geometry here is either constructed
// by hand in metres or copied verbatim out of the live `segments` table, and
// the real ones carry their segment id so they can be re-fetched and checked.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OFFSET_M,
  MAX_TANGENT_DELTA_DEG,
  STEP_M,
  toLocalMetres,
  headingDeg,
  headingDelta,
  projectToPolyline,
  sampleSteps,
  measureFrontage,
  MIN_LEG_M,
} from "./frontage.mjs";

// ---------------------------------------------------------------- helpers

// Build [lon, lat] from metre offsets so a fixture reads as a drawing. Uses the
// same flat-earth constants as the module; over the 150m these tests span, the
// error against WGS84 is millimetres and every threshold here is metres.
const LAT0 = 38.82;
const LON0 = -104.8;
const M_PER_DEG_LAT = 111132.0;
const M_PER_DEG_LON = 111320.0 * Math.cos((LAT0 * Math.PI) / 180);
const at = (eastM, northM) => [LON0 + eastM / M_PER_DEG_LON, LAT0 + northM / M_PER_DEG_LAT];

// The rule this change replaces: compass bearing of the straight line from a
// segment's first point to its last, compared modulo 180. Written out
// independently (great-circle initial bearing, as turf.bearing computes it in
// split_ways.mjs) so the control test below is not checking the new code
// against itself.
function chordBearingDeg(coords) {
  const [lon1, lat1] = coords[0];
  const [lon2, lat2] = coords[coords.length - 1];
  const r = Math.PI / 180;
  const dLon = (lon2 - lon1) * r;
  const p1 = lat1 * r;
  const p2 = lat2 * r;
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function chordDelta(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 360 - d, Math.abs(d - 180));
}

// ------------------------------------------------------- headings and angles

test("headingDeg reads the local plane, folded onto [0,180)", () => {
  assert.equal(headingDeg(0, 0, 10, 0), 0); // east
  assert.equal(headingDeg(0, 0, 0, 10), 90); // north
  assert.equal(headingDeg(0, 0, -10, 0), 0); // west folds onto east
  assert.equal(headingDeg(0, 0, 0, -10), 90); // south folds onto north
  assert.ok(Math.abs(headingDeg(0, 0, 10, 10) - 45) < 1e-9);
  assert.ok(Math.abs(headingDeg(0, 0, -10, 10) - 135) < 1e-9);
});

test("headingDelta treats antiparallel as parallel", () => {
  assert.equal(headingDelta(0, 180), 0);
  assert.equal(headingDelta(0, 0), 0);
  assert.equal(headingDelta(0, 90), 90);
  assert.equal(headingDelta(10, 170), 20);
  assert.equal(headingDelta(179, 1), 2);
  assert.equal(headingDelta(91, 89), 2);
  // Never exceeds a right angle: two undirected lines cannot differ by more.
  for (let a = 0; a < 180; a += 7) {
    for (let b = 0; b < 180; b += 11) {
      const d = headingDelta(a, b);
      assert.ok(d >= 0 && d <= 90, `delta(${a},${b}) = ${d}`);
    }
  }
});

// ------------------------------------------------------------- projection

test("projectToPolyline finds the perpendicular distance and the leg", () => {
  const road = new Float64Array([0, 0, 100, 0]); // due east, 100m
  const { distM, legIndex } = projectToPolyline(50, 8, road);
  assert.equal(legIndex, 0);
  assert.ok(Math.abs(distM - 8) < 1e-9);
});

test("projectToPolyline clamps past the end rather than extrapolating", () => {
  const road = new Float64Array([0, 0, 100, 0]);
  // 30m beyond the east end and 40m north: nearest point is the endpoint.
  const { distM } = projectToPolyline(130, 40, road);
  assert.ok(Math.abs(distM - 50) < 1e-9, `got ${distM}`);
});

test("projectToPolyline picks the nearer leg of a corner, which is what gives the local tangent", () => {
  // East 100m, then north 100m.
  const road = new Float64Array([0, 0, 100, 0, 100, 100]);
  assert.equal(projectToPolyline(20, 5, road).legIndex, 0);
  assert.equal(projectToPolyline(105, 60, road).legIndex, 1);
});

test("projectToPolyline reports no leg for a degenerate polyline", () => {
  assert.equal(projectToPolyline(0, 0, new Float64Array([5, 5])).legIndex, -1);
});

test("projectToPolyline resolves an exact tie to the first leg", () => {
  // Three collinear points, which OSM emits constantly. A point off the middle
  // vertex is the same distance from both legs, bit for bit, because both
  // reduce to the distance from that vertex. Whichever leg is chosen the
  // tangent is identical, so this pins determinism, not correctness.
  const road = new Float64Array([-10, 0, 0, 0, 10, 0]);
  const { distM, legIndex } = projectToPolyline(0, -5, road);
  assert.ok(Math.abs(distM - 5) < 1e-12);
  assert.equal(legIndex, 0);
});

// ------------------------------------------------------------- sampling

test("sampleSteps conserves length", () => {
  const flat = new Float64Array([0, 0, 37, 0, 37, 21]);
  const total = sampleSteps(flat).reduce((a, s) => a + s.lengthM, 0);
  assert.ok(Math.abs(total - 58) < 1e-9, `got ${total}`);
});

test("sampleSteps splits a leg into whole steps of at most STEP_M", () => {
  const samples = sampleSteps(new Float64Array([0, 0, 12, 0]), 5);
  assert.equal(samples.length, 3); // ceil(12/5)
  for (const s of samples) assert.ok(Math.abs(s.lengthM - 4) < 1e-9);
  // Midpoints, not vertices: first sample sits 2m in, not at the origin.
  assert.ok(Math.abs(samples[0].x - 2) < 1e-9);
});

test("sampleSteps keeps a leg shorter than one step", () => {
  const samples = sampleSteps(new Float64Array([0, 0, 3, 0]), 5);
  assert.equal(samples.length, 1);
  assert.ok(Math.abs(samples[0].lengthM - 3) < 1e-9);
});

test("sampleSteps skips a repeated vertex rather than emitting a headingless sample", () => {
  const flat = new Float64Array([0, 0, 10, 0, 10, 0, 20, 0]);
  const samples = sampleSteps(flat, 5);
  const total = samples.reduce((a, s) => a + s.lengthM, 0);
  assert.ok(Math.abs(total - 20) < 1e-9);
  // Four 5m steps and nothing else. A zero-length leg has no direction --
  // atan2(0,0) is 0, which is a heading due east that nothing is pointing --
  // and although it carries no length to skew a fraction, it has no business
  // in the sample list.
  assert.equal(samples.length, 4);
  for (const s of samples) assert.equal(s.heading, 0);
});

test("sampleSteps carries the heading of the leg a step came from", () => {
  const samples = sampleSteps(new Float64Array([0, 0, 10, 0, 10, 10]), 5);
  assert.deepEqual(
    samples.map((s) => Math.round(s.heading)),
    [0, 0, 90, 90],
  );
});

// ------------------------------------------------- frontage, constructed cases

const straightRoad = { id: 1, coords: [at(0, 0), at(200, 0)] };

test("a pavement running beside a street scores full frontage", () => {
  const path = [at(10, 8), at(150, 8)];
  const m = measureFrontage(path, [straightRoad]);
  assert.ok(m.frontage > 0.999, `frontage ${m.frontage}`);
  assert.equal(m.parentId, 1);
});

test("digitised direction does not matter", () => {
  const forward = measureFrontage([at(10, 8), at(150, 8)], [straightRoad]);
  const backward = measureFrontage([at(150, 8), at(10, 8)], [straightRoad]);
  assert.ok(Math.abs(forward.frontage - backward.frontage) < 1e-9);
  assert.equal(backward.parentId, 1);
});

test("a path beyond the offset limit scores nothing", () => {
  const m = measureFrontage([at(10, 30), at(150, 30)], [straightRoad]);
  assert.equal(m.frontage, 0);
  assert.equal(m.parentId, null);
});

test("a connector crossing the street scores nothing, though both ends are close to tarmac", () => {
  // Due north across the road: every step is near it, none points its way.
  const m = measureFrontage([at(100, -15), at(100, 15)], [straightRoad]);
  assert.equal(m.frontage, 0);
  assert.equal(m.parentId, null);
});

test("a path between two parallel streets scores nothing even though it is always near one", () => {
  const north = { id: 1, coords: [at(0, 0), at(200, 0)] };
  const south = { id: 2, coords: [at(0, -36), at(200, -36)] };
  const m = measureFrontage([at(100, -1), at(100, -35)], [north, south]);
  assert.equal(m.frontage, 0);
});

test("frontage survives a bend the chord cannot", () => {
  // Road and pavement both turn the same 90 degree corner, 8m apart. The chord
  // of each runs diagonally, so a chord test sees them as parallel here by
  // luck; the point is that frontage sees it correctly rather than by luck.
  const road = { id: 1, coords: [at(0, 0), at(100, 0), at(100, 100)] };
  const path = [at(0, 8), at(92, 8), at(92, 100)];
  const m = measureFrontage(path, [road]);
  assert.ok(m.frontage > 0.9, `frontage ${m.frontage}`);
});

test("a path straddling two pieces of one street folds, and picks the longer share", () => {
  // Roads are split at junctions and capped at 150m; paths are split on their
  // own nodes. Measuring against a single piece is what would score this 50%.
  const pieceA = { id: 10, coords: [at(0, 0), at(100, 0)] };
  const pieceB = { id: 11, coords: [at(100, 0), at(200, 0)] };
  const path = [at(20, 8), at(180, 8)]; // 80m beside A, 80m beside B
  const m = measureFrontage(path, [pieceA, pieceB]);
  assert.ok(m.frontage > 0.999, `frontage ${m.frontage}`);
  assert.ok(m.parentFrontage < 0.55, `one piece alone would only hold ${m.parentFrontage}`);

  const lopsided = measureFrontage([at(20, 8), at(140, 8)], [pieceA, pieceB]);
  assert.ok(lopsided.frontage > 0.999);
  assert.equal(lopsided.parentId, 10, "80m beside A beats 40m beside B");
});

test("no roads means no frontage, but the path still reports its length", () => {
  const m = measureFrontage([at(0, 0), at(50, 0)], []);
  assert.equal(m.frontage, 0);
  assert.equal(m.parentId, null);
  assert.ok(Math.abs(m.lengthM - 50) < 0.01, `lengthM ${m.lengthM}`);
});

test("a path with too few points is measured as nothing rather than throwing", () => {
  for (const degenerate of [[], [at(0, 0)], null, undefined]) {
    const m = measureFrontage(degenerate, [straightRoad]);
    assert.equal(m.frontage, 0);
    assert.equal(m.lengthM, 0);
  }
});

test("a road with a single point is ignored rather than throwing", () => {
  const m = measureFrontage([at(10, 8), at(150, 8)], [{ id: 9, coords: [at(0, 0)] }]);
  assert.equal(m.frontage, 0);
});

test("a non-finite coordinate refuses the measurement instead of inflating it", () => {
  // The leg that disagrees with the road is the one that disappears, so
  // dropping it silently reads as perfect frontage. Without the guard this
  // path measures 0.2120 clean and exactly 1.0000 poisoned -- it would go from
  // staying canonical to folding, on one bad number.
  const road = { id: 1, coords: [at(0, 0), at(180, 0)] };
  const clean = [at(0, 8), at(90, 8), at(90, 330)];
  const control = measureFrontage(clean, [road]);
  assert.ok(control.frontage > 0.15 && control.frontage < 0.3, `control ${control.frontage}`);

  for (const bad of [NaN, Infinity, -Infinity]) {
    const poisoned = [at(0, 8), at(90, 8), [-104.799, bad]];
    const m = measureFrontage(poisoned, [road]);
    assert.equal(m.frontage, 0, `${bad} should refuse, not score`);
    assert.equal(m.parentId, null);
  }
});

test("a road with a non-finite coordinate is dropped, not used for the legs that happen to be finite", () => {
  // The bad ordinate is in the LAST point, so the road's first leg is perfectly
  // usable and sits 4m from the path against the good road's 8m. Nothing else
  // stops it winning: a NaN distance clears `distM > maxOffsetM` and a NaN
  // heading clears the tangent test, because both are comparisons against NaN
  // and both are false. Only the guard keeps a half-corrupt road out.
  const good = { id: 1, coords: [at(0, 0), at(200, 0)] };
  const halfBad = { id: 2, coords: [at(0, 12), at(200, 12), [-104.79, NaN]] };
  const m = measureFrontage([at(20, 8), at(180, 8)], [good, halfBad]);
  assert.ok(m.frontage > 0.999, `frontage ${m.frontage}`);
  assert.equal(m.parentId, 1, "the intact road, though it is the further one");
  assert.equal(m.byRoad.has(2), false);
});

test("a step is credited to the CLOSEST accepting road, not just any of them", () => {
  // The comment beside this logic calls it load-bearing against crediting every
  // road at once, and "every road" does die -- but crediting the FURTHEST
  // accepting road survived the suite, so the word "closest" was not a tested
  // fact. Two parallel roads flanking the path at 4m and 16m: both accept every
  // step, and the near one must take all of it.
  const near = { id: 1, coords: [at(0, 0), at(200, 0)] };
  const far = { id: 2, coords: [at(0, 20), at(200, 20)] };
  const m = measureFrontage([at(20, 4), at(180, 4)], [near, far]);
  assert.ok(m.frontage > 0.999, "both roads accept, so the path is fully alongside");
  assert.equal(m.parentId, 1, "the 4m road, not the 16m one");
  assert.equal(m.byRoad.has(2), false, "and the far road is credited nothing at all");
});

test("the answer does not depend on the order the roads arrive in", () => {
  // Nominally equidistant either side of the path. In floating point one of
  // them is microscopically nearer, so this does not test a tie -- it tests
  // that whichever wins, wins regardless of row order.
  const above = { id: 77, coords: [at(0, 16), at(200, 16)] };
  const below = { id: 42, coords: [at(0, 0), at(200, 0)] };
  const path = [at(20, 8), at(180, 8)];
  const a = measureFrontage(path, [above, below]);
  const b = measureFrontage(path, [below, above]);
  assert.equal(a.parentId, b.parentId);
  assert.equal(a.frontage, b.frontage);
});

test("an exact tie in frontage goes to the lower id", () => {
  // Reachable, unlike an exact tie in distance: two pieces of one street, each
  // flanking exactly half the path. 80m each, so the totals are equal to the
  // bit and the id is the only thing left to decide it.
  const west = { id: 77, coords: [at(0, 0), at(80, 0)] };
  const east = { id: 42, coords: [at(80, 0), at(160, 0)] };
  const path = [at(0, 8), at(160, 8)];
  const m = measureFrontage(path, [west, east]);
  assert.equal(m.byRoad.get(77), m.byRoad.get(42), "the fixture must actually tie");
  assert.equal(m.parentId, 42);
});

// --------------------------------------------- the bug, with the real geometry
//
// Copied from `segments` on 2026-09-27. #23278 is the unnamed footway beside
// Hancock Expressway that punched the 191m hole described in context/session.md.

const SEG_23278 = [
  [-104.805165938, 38.819286524],
  [-104.8048203, 38.8192725],
  [-104.8047636, 38.8192418],
  [-104.804697, 38.81919],
  [-104.804739365, 38.818274477],
];
const SEG_22505 = [
  [-104.8053831, 38.8194473],
  [-104.8049213, 38.8194306],
  [-104.804754, 38.8194531],
  [-104.804667, 38.8195132],
  [-104.804650968, 38.819867451],
];
const HANCOCK_17972 = {
  id: 17972,
  coords: [
    [-104.804477012, 38.820223366],
    [-104.8045064, 38.8197015],
    [-104.8045213, 38.819324],
  ],
};
const HANCOCK_17973 = {
  id: 17973,
  coords: [
    [-104.8045213, 38.819324],
    [-104.804565353, 38.818504044],
  ],
};
const HANCOCK_17974 = {
  id: 17974,
  coords: [
    [-104.804565353, 38.818504044],
    [-104.8045877, 38.8180881],
    [-104.8046065, 38.817684],
  ],
};
const TRANSIT_4847 = {
  id: 4847,
  coords: [
    [-104.8045213, 38.819324],
    [-104.8047595, 38.8193317],
    [-104.8053064, 38.8193494],
    [-104.8053837, 38.8193454],
    [-104.8054489, 38.8193421],
    [-104.8055841, 38.8193164],
    [-104.8057086, 38.8192689],
    [-104.8058124, 38.8192059],
    [-104.8058969, 38.81913],
    [-104.8059268, 38.8190904],
    [-104.8059563, 38.8190513],
    [-104.805956428, 38.819050981],
  ],
};

test("CONTROL: the chord rule really does reject #23278, so the fixture reproduces the bug", () => {
  // If this ever starts passing the 20 degree test, the fixture has drifted and
  // every assertion below it is measuring nothing.
  const path = chordBearingDeg(SEG_23278);
  const road = chordBearingDeg(HANCOCK_17973.coords);
  assert.ok(Math.abs(path - 161.8) < 0.1, `stored bearing_deg was 161.8, computed ${path}`);
  assert.ok(Math.abs(road - 182.4) < 0.1, `stored bearing_deg was 182.4, computed ${road}`);
  const delta = chordDelta(path, road);
  assert.ok(delta > MAX_TANGENT_DELTA_DEG, `chord delta ${delta} should exceed the 20 degree tolerance`);
  assert.ok(delta < 21, `and it should miss narrowly, not wildly: ${delta}`);
});

test("#23278 runs alongside Hancock for 70% of its length, which the chord averaged away", () => {
  const m = measureFrontage(SEG_23278, [HANCOCK_17973, HANCOCK_17974]);
  assert.ok(m.frontage > 0.65 && m.frontage < 0.75, `frontage ${m.frontage}`);
  assert.equal(m.parentId, 17973, "the piece holding the larger share");
});

test("with the cross street in play #23278 is alongside something for 90% of its length", () => {
  // The 30m east leg is Transit Drive's pavement; the 102m south leg is
  // Hancock's. Only the ~14m corner radius belongs to neither, which is right.
  const m = measureFrontage(SEG_23278, [TRANSIT_4847, HANCOCK_17973, HANCOCK_17974]);
  assert.ok(m.frontage > 0.85, `frontage ${m.frontage}`);
  assert.equal(m.parentId, 17973, "Hancock holds the largest single share, so it is the parent");
  assert.ok(m.byRoad.get(4847) > 25, "Transit still gets credited its own leg");
});

test("#22505 needs the union: it is only 38% Hancock, but 76% pavement", () => {
  const hancockOnly = measureFrontage(SEG_22505, [HANCOCK_17972]);
  assert.ok(hancockOnly.frontage > 0.34 && hancockOnly.frontage < 0.42, `got ${hancockOnly.frontage}`);

  const both = measureFrontage(SEG_22505, [TRANSIT_4847, HANCOCK_17972]);
  assert.ok(both.frontage > 0.7, `got ${both.frontage}`);
  assert.notEqual(both.parentId, null);
});

test("a cycleway that merely clips a road is not folded into it", () => {
  // #52602, 143m, chord 300.8 against Dublin Boulevard's 218.4. They touch near
  // one end and diverge. The chord rule rejects this and so must frontage --
  // a fix that folds it would be worse than the bug.
  const seg52602 = [
    [-104.7489689, 38.9294584],
    [-104.750385816, 38.930115115],
  ];
  const dublin = {
    id: 47223,
    coords: [
      [-104.748407353, 38.929845794],
      [-104.748538, 38.9297187],
      [-104.7486577, 38.9296081],
      [-104.7488512, 38.9294074],
      [-104.74946571, 38.928803514],
    ],
  };
  const m = measureFrontage(seg52602, [dublin]);
  assert.ok(m.frontage < 0.1, `frontage ${m.frontage} -- this must stay canonical`);
});

// The two limits, against LITERALS rather than against the constants.
//
// Both of these used to build their fixtures from `MAX_OFFSET_M ± 1` and
// `MAX_TANGENT_DELTA_DEG ± 2` and then check them against the same constant, so
// they passed at MAX_OFFSET_M = 200 and at MAX_TANGENT_DELTA_DEG = 2 -- the bug
// in both directions. A test whose fixture moves with the thing under test
// measures nothing.

test("the offset limit is 20 metres, in metres, not whatever the constant says", () => {
  assert.equal(MAX_OFFSET_M, 20, "if this moves deliberately, move the fixtures below with it");
  assert.ok(measureFrontage([at(10, 19), at(150, 19)], [straightRoad]).frontage > 0.999);
  assert.equal(measureFrontage([at(10, 21), at(150, 21)], [straightRoad]).frontage, 0);
  // A metre either side of 20 is a fine-grained claim; check it is really the
  // distance being tested and not something coincidental at that scale.
  assert.equal(measureFrontage([at(10, 60), at(150, 60)], [straightRoad]).frontage, 0);
  assert.ok(measureFrontage([at(10, 2), at(150, 2)], [straightRoad]).frontage > 0.999);
});

test("the tangent limit is 20 degrees, in degrees", () => {
  assert.equal(MAX_TANGENT_DELTA_DEG, 20, "if this moves deliberately, move the fixtures below with it");
  const rad = (d) => (d * Math.PI) / 180;
  // Splayed away from a road it starts 8m from, short enough to stay inside the
  // offset limit over its whole length whatever the angle.
  const splay = (deg) => [at(0, 8), at(40 * Math.cos(rad(deg)), 8 + 40 * Math.sin(rad(deg)))];
  assert.ok(measureFrontage(splay(18), [straightRoad]).frontage > 0.999, "18 degrees is inside");
  assert.equal(measureFrontage(splay(22), [straightRoad]).frontage, 0, "22 degrees is outside");
  assert.ok(measureFrontage(splay(2), [straightRoad]).frontage > 0.999);
  assert.equal(measureFrontage(splay(45), [straightRoad]).frontage, 0);
});

test("STEP_M is 5 metres, which is what makes a 150m piece ~30 steps", () => {
  assert.equal(STEP_M, 5);
  assert.equal(sampleSteps(new Float64Array([0, 0, 150, 0])).length, 30);
  // Short enough to resolve a corner on the shortest segment split_ways emits.
  assert.ok(STEP_M < 8, "a segment can be as short as 8m");
});

test("toLocalMetres is wrong by ~0.1%, and that is small enough for what it feeds", () => {
  // The old version of this test built its input with `at()`, which uses the
  // module's own constants, and then checked the output against those same
  // constants. It asserted the projection agrees with itself, passed at any
  // value, and went RED when the constants were replaced with the correct ones.
  //
  // So compute the truth independently: WGS84 metres per degree from the
  // meridian arc and the parallel radius. No shared constant with the module.
  const D = Math.PI / 180;
  const trueLat = 111132.954 - 559.822 * Math.cos(2 * LAT0 * D) + 1.175 * Math.cos(4 * LAT0 * D);
  const a = 6378137;
  const e2 = 0.00669437999014;
  const s = Math.sin(LAT0 * D);
  const trueLon = ((a * Math.cos(LAT0 * D)) / Math.sqrt(1 - e2 * s * s)) * D;

  // Walk 150m -- the longest a segment can be -- each way, in true degrees.
  const north = [[LON0, LAT0], [LON0, LAT0 + 150 / trueLat]];
  const east = [[LON0, LAT0], [LON0 + 150 / trueLon, LAT0]];
  const dn = toLocalMetres(north, LAT0, LON0)[3];
  const de = toLocalMetres(east, LAT0, LON0)[2];

  // Measured: 0.162m long north-south, 0.197m short east-west. Not "well under
  // a centimetre", which is what the module used to claim.
  assert.ok(Math.abs(dn - 150) < 0.25, `150m north measured ${dn.toFixed(3)}m`);
  assert.ok(Math.abs(de - 150) < 0.25, `150m east measured ${de.toFixed(3)}m`);

  // The claim that matters is not "accurate" but "accurate enough". A true 20m
  // offset must still be decided as 20m against MAX_OFFSET_M, and the two axes
  // scaling differently must not skew a heading by anything like 20 degrees.
  const scaleN = dn / 150;
  const scaleE = de / 150;
  assert.ok(Math.abs(20 * scaleN - 20) < 0.05, "a 20m offset misreads by under 5cm");
  assert.ok(Math.abs(20 * scaleE - 20) < 0.05);
  let worstSkew = 0;
  for (let deg = 0; deg < 90; deg += 0.25) {
    const r = Math.atan2(scaleN * Math.sin(deg * D), scaleE * Math.cos(deg * D)) / D;
    worstSkew = Math.max(worstSkew, Math.abs(r - deg));
  }
  assert.ok(worstSkew < 0.1, `worst angular skew ${worstSkew.toFixed(4)} degrees`);
  assert.ok(worstSkew * 100 < MAX_TANGENT_DELTA_DEG, "two orders of magnitude of headroom");
});

test("a repeated vertex in a ROAD cannot fabricate a heading and win the tie-break", () => {
  // atan2(0,0) is 0 -- due east, which nothing is pointing. Worse,
  // projectToPolyline prefers the earlier leg on a tie, and a duplicated
  // leading vertex is exactly equidistant with the real leg from every point
  // past the start, so the fabricated heading wins.
  //
  // Live `segments` has no repeated vertices today, but turf.lineSliceAlong
  // emits them and split_ways.mjs uses it, so the next import can arm this.
  // The crossing must sit AT the duplicated vertex. The degenerate leg is a
  // single point, so its "distance" is the distance to that point -- a crossing
  // 96m up the road is nearer the real leg and never reaches the bad one, which
  // is how an earlier version of this test passed with the guard deleted.
  const northSouth = (coords) => ({ id: 1, coords });
  const clean = northSouth([at(0, 0), at(0, 100)]);
  const duped = northSouth([at(0, 0), at(0, 0), at(0, 100)]);
  const crossing = [at(-6, 0), at(6, 0)]; // due east, straight through the origin

  assert.equal(measureFrontage(crossing, [clean]).frontage, 0, "control: no duplicate, no fold");
  const bad = measureFrontage(crossing, [duped]);
  assert.equal(bad.frontage, 0, "a fabricated due-east heading must not fold a perpendicular path");
  assert.equal(bad.parentId, null);

  // And a genuine pavement beside the same duplicated road still folds: the
  // guard drops the bad leg, not the road.
  const pavement = [at(8, 10), at(8, 90)];
  assert.ok(measureFrontage(pavement, [duped]).frontage > 0.999);
  assert.equal(measureFrontage(pavement, [duped]).parentId, 1);
});
