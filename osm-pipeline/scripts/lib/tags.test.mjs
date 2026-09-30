import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isTunnel, ROAD_HIGHWAYS, EXCLUDED_HIGHWAYS } from "./tags.mjs";

// -- classify -----------------------------------------------------------------
//
// These pin behaviour that already shipped. `classify` lived inside
// split_ways.mjs with no tests at all until the tunnel flag moved it here, so
// the point of this block is to prove the move changed nothing, and to stop the
// next edit to the highway lists silently deleting a category of the map.

test("classify: no highway tag is not a way we can ride", () => {
  assert.equal(classify({}), null);
  assert.equal(classify({ name: "Somewhere" }), null);
  assert.equal(classify(), null);
});

test("classify: every road highway is a road", () => {
  for (const highway of ROAD_HIGHWAYS) {
    assert.equal(classify({ highway }), "road", highway);
  }
});

test("classify: every excluded highway is dropped", () => {
  for (const highway of EXCLUDED_HIGHWAYS) {
    assert.equal(classify({ highway }), null, highway);
  }
});

test("classify: cycleway and designated path are cycleways", () => {
  assert.equal(classify({ highway: "cycleway" }), "cycleway");
  assert.equal(classify({ highway: "path", bicycle: "designated" }), "cycleway");
});

test("classify: footway, pedestrian and undesignated path are footways", () => {
  assert.equal(classify({ highway: "footway" }), "footway");
  assert.equal(classify({ highway: "pedestrian" }), "footway");
  assert.equal(classify({ highway: "path" }), "footway");
  assert.equal(classify({ highway: "path", bicycle: "yes" }), "footway");
});

test("classify: a footway crossing is dropped", () => {
  assert.equal(classify({ highway: "footway", footway: "crossing" }), null);
  // A sidewalk is not a crossing and must survive -- the whole fold depends on
  // these reaching the database.
  assert.equal(classify({ highway: "footway", footway: "sidewalk" }), "footway");
});

test("classify: track needs explicit bike access, and designated makes it a cycleway", () => {
  assert.equal(classify({ highway: "track" }), null);
  assert.equal(classify({ highway: "track", bicycle: "no" }), null);
  assert.equal(classify({ highway: "track", access: "private" }), null);
  assert.equal(classify({ highway: "track", bicycle: "designated" }), "cycleway");
  assert.equal(classify({ highway: "track", bicycle: "yes" }), "footway");
  assert.equal(classify({ highway: "track", bicycle: "permissive" }), "footway");
  // Never a road: link_canonical.mjs treats `road` as a fold *parent*, so a
  // track calling itself a road would absorb the trails beside it.
  for (const bicycle of ["yes", "designated", "permissive"]) {
    assert.notEqual(classify({ highway: "track", bicycle }), "road", bicycle);
  }
});

test("classify: access=no or private is overridden by explicit bike access", () => {
  assert.equal(classify({ highway: "path", access: "no" }), null);
  assert.equal(classify({ highway: "path", access: "private" }), null);
  assert.equal(classify({ highway: "path", access: "no", bicycle: "designated" }), "cycleway");
  assert.equal(classify({ highway: "path", access: "private", bicycle: "yes" }), "footway");
  // `dismount` and `destination` are not access grants.
  assert.equal(classify({ highway: "path", access: "no", bicycle: "dismount" }), null);
  assert.equal(classify({ highway: "path", access: "no", bicycle: "destination" }), null);
  // Other access values are left alone entirely.
  assert.equal(classify({ highway: "residential", access: "customers" }), "road");
});

test("classify: an unrecognised highway value is dropped, not guessed", () => {
  assert.equal(classify({ highway: "bridleway" }), null);
  assert.equal(classify({ highway: "via_ferrata" }), null);
  assert.equal(classify({ highway: "" }), null);
});

// -- isTunnel -----------------------------------------------------------------

test("isTunnel: tunnel=yes is a tunnel", () => {
  assert.equal(isTunnel({ highway: "path", tunnel: "yes" }), true);
});

test("isTunnel: building_passage is a tunnel", () => {
  assert.equal(isTunnel({ highway: "footway", tunnel: "building_passage" }), true);
  assert.equal(isTunnel({ highway: "footway", covered: "building_passage" }), true);
});

test("isTunnel: a value we have never seen still reads as covered", () => {
  // The point of listing negatives instead of positives. All of these are real
  // OSM values that mean a structure overhead, and none appears in the current
  // extract, so a positive list would silently miss them the day one arrives.
  for (const tunnel of ["culvert", "passage", "flooded", "avalanche_protector", "1"]) {
    assert.equal(isTunnel({ tunnel }), true, tunnel);
  }
});

test("isTunnel: no, false and empty are not tunnels", () => {
  assert.equal(isTunnel({ tunnel: "no" }), false);
  assert.equal(isTunnel({ tunnel: "false" }), false);
  assert.equal(isTunnel({ tunnel: "" }), false);
});

test("isTunnel: nothing overhead by default", () => {
  assert.equal(isTunnel({}), false);
  assert.equal(isTunnel(), false);
  assert.equal(isTunnel({ highway: "residential", name: "Cascade Avenue" }), false);
});

test("isTunnel: covered=yes is a roof without a tunnel", () => {
  assert.equal(isTunnel({ covered: "yes" }), true);
  assert.equal(isTunnel({ covered: "no" }), false);
  // 167 ways in the extract carry covered=no; treating a declared absence as a
  // presence would flag Hancock Expressway and East Platte Avenue.
  assert.equal(isTunnel({ highway: "primary", name: "Hancock Expressway", covered: "no" }), false);
});

test("isTunnel: tunnel wins over covered=no", () => {
  // Real combination: way 50426150, tunnel=yes covered=yes. The inverse is what
  // this guards -- a mapper who set covered=no on a tagged tunnel must not
  // un-flag it.
  assert.equal(isTunnel({ tunnel: "yes", covered: "no" }), true);
  assert.equal(isTunnel({ tunnel: "yes", covered: "yes" }), true);
});

test("isTunnel: layer alone is a grade separation, not a roof", () => {
  // THE IMPORTANT NEGATIVE. 283 ways in the extract carry a layer tag and
  // almost all are the lower road under an overpass, twenty metres with open
  // sky either side. If layer counted, most of the city's junctions would be
  // excused from every defect count.
  for (const layer of ["-1", "-2", "-3", "1", "2", "0"]) {
    assert.equal(isTunnel({ highway: "residential", layer }), false, layer);
  }
});

test("isTunnel: a bridge is the opposite of a tunnel", () => {
  assert.equal(isTunnel({ highway: "residential", bridge: "yes", layer: "1" }), false);
});

test("isTunnel: the name is never read", () => {
  // "Union Boulevard Underpass" is tagged tunnel=yes and does not need the
  // name. Inferring from it would also catch the surface street named after
  // the structure beside it.
  assert.equal(isTunnel({ highway: "path", name: "Union Boulevard Underpass" }), false);
  assert.equal(isTunnel({ highway: "path", name: "Tunnel Road" }), false);
});

// -- the two rules together ---------------------------------------------------

test("a tunnel is still classified by its highway tag", () => {
  // CONTROL. The flag only means anything if the covered segments are in the
  // database to carry it. If some later edit made `classify` drop tunnels, the
  // column would be all false and every tunnel hole would read as a defect --
  // the exact confusion this work exists to remove, restored quietly.
  assert.equal(classify({ highway: "tertiary", tunnel: "yes" }), "road");
  assert.equal(classify({ highway: "path", tunnel: "yes", bicycle: "designated" }), "cycleway");
  assert.equal(classify({ highway: "footway", tunnel: "yes" }), "footway");
  assert.equal(classify({ highway: "residential", covered: "yes" }), "road");
});

// Real tag sets, copied from data/extract.json on 2026-09-29. The rule above is
// only useful if it lands on the ways Julian can point at on the map, so these
// name them. Gold Camp Road is the case that started this: the unpainted
// stretch at 38.79434/-104.89812 is the old railroad tunnels.
const REAL_WAYS = [
  // [osm way id, tags, expected kind, expected isTunnel, note]
  [99568977, { highway: "tertiary", name: "Gold Camp Road", tunnel: "yes", layer: "-1" }, "road", true, "Gold Camp Road tunnel"],
  [99569027, { highway: "unclassified", name: "Gold Camp Road", tunnel: "yes", layer: "-1" }, "road", true, "Gold Camp Road tunnel"],
  [117996143, { highway: "tertiary", name: "Gold Camp Road", tunnel: "yes" }, "road", true, "Gold Camp Road tunnel"],
  [99569121, { highway: "unclassified", name: "Gold Camp Road", tunnel: "yes", bicycle: "no", access: "no" }, null, true, "closed to bikes, so it never reaches the database and the flag is moot"],
  [229743725, { highway: "path", name: "Union Boulevard Underpass", tunnel: "yes", bicycle: "designated", layer: "-3" }, "cycleway", true, "underpass on a bike trail"],
  [196623144, { highway: "path", name: "Rock Island Trail", tunnel: "yes", bicycle: "designated", layer: "-1" }, "cycleway", true, "Rock Island Trail underpass"],
  [229837818, { highway: "path", name: "Sinton Trail", tunnel: "yes", bicycle: "designated", layer: "-1" }, "cycleway", true, "Sinton Trail underpass"],
  [461222269, { highway: "secondary", name: "O'Connell Boulevard", tunnel: "building_passage" }, "road", true, "road through a building"],
  [191675705, { highway: "primary_link", covered: "yes" }, "road", true, "covered ramp, no tunnel tag"],
  [43932966, { highway: "primary", name: "Hancock Expressway", covered: "no" }, "road", false, "declares itself uncovered"],
  [368893632, { highway: "path", name: "Chamberlain", covered: "no" }, "footway", false, "declares itself uncovered"],
  [141847999, { highway: "service", tunnel: "yes", access: "permissive" }, null, true, "service road, dropped for being a service road"],
];

test("real ways from the extract classify and flag as expected", () => {
  for (const [id, tags, kind, tunnel, note] of REAL_WAYS) {
    assert.equal(classify(tags), kind, `way ${id} kind (${note})`);
    assert.equal(isTunnel(tags), tunnel, `way ${id} tunnel (${note})`);
  }
});

test("the extract really does contain tunnels for the flag to find", () => {
  // Guards the case where the rule is right and the data is not: an extract
  // fetched with a query that drops tags, or a bbox with no tunnels in it,
  // would make every count below read zero and look like good news.
  const flagged = REAL_WAYS.filter(([, tags, kind]) => kind !== null && isTunnel(tags));
  assert.ok(flagged.length >= 8, `expected 8+ rideable covered ways, got ${flagged.length}`);
});
