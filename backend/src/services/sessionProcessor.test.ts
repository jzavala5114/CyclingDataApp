import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collectRevisits, runElevationSource, siteKeyFor } from "./sessionProcessor.js";
import type { Direction } from "../types/index.js";

// collectRevisits is where the drift measurement comes from, so what it counts
// as "the same ground twice" decides whether the ramp in anchorFit.ts is fitted
// to evidence or to an illusion. It is pure and takes no database, so it is a
// gate test.

const MINUTE = 60_000;

function pass(
  segmentId: number,
  direction: Direction,
  atMin: number,
  buckets: Array<[distanceM: number, elevationM: number]>,
  elevationSource: "barometer" | "gps" | "mixed" | null = "barometer",
  // The place, which is not the segment: segment ids split at every junction, so
  // consecutive pieces of one street share a site. Defaults to one site per
  // segment because most tests here are not about that rule; the one that is
  // passes the same key for several segments.
  siteKey = `street-${segmentId}`,
) {
  return {
    segmentId,
    direction,
    atMs: atMin * MINUTE,
    buckets: buckets.map(([distanceM, elevationM]) => ({ distanceM, elevationM })),
    elevationSource,
    siteKey,
  };
}

test("one pass over a segment is not a revisit", () => {
  assert.deepEqual(collectRevisits([pass(1, "forward", 0, [[0, 100], [15, 101], [30, 102]])]), []);
});

test("two passes over the same ground are ONE comparison, not one per bucket", () => {
  // The bug this rule exists for. A single out-and-back over one block touches
  // four or five buckets, but they all share the same two moments and the same
  // disagreement. Emitting one revisit per bucket let that single comparison
  // satisfy a quorum meant to need three independent ones, and made a median
  // of four copies of one number look like a robust estimate.
  const revisits = collectRevisits([
    pass(1, "forward", 0, [[0, 100], [15, 101], [30, 102], [45, 103]]),
    pass(1, "forward", 40, [[0, 103], [15, 104], [30, 105], [45, 106]]),
  ]);
  assert.equal(revisits.length, 1);
  assert.equal(revisits[0].riseM, 3);
  assert.equal(revisits[0].buckets, 4, "the four shared cells back one comparison");
  assert.equal(revisits[0].earlyAtMs, 0);
  assert.equal(revisits[0].lateAtMs, 40 * MINUTE);
});

test("the rise is the median across the buckets the two passes share", () => {
  // One cell that caught a bad fix must not set the comparison for the pair.
  const revisits = collectRevisits([
    pass(1, "forward", 0, [[0, 100], [15, 100], [30, 100], [45, 100]]),
    pass(1, "forward", 35, [[0, 101], [15, 101.1], [30, 100.9], [45, 109]]),
  ]);
  assert.equal(revisits.length, 1);
  assert.ok(Math.abs(revisits[0].riseM - 1.05) < 1e-9, `rise ${revisits[0].riseM}`);
});

test("the same segment ridden the other way is not the same ground", () => {
  // A bucket's distance is measured along the direction of travel, so forward
  // 30m and backward 30m are opposite ends of the segment. Comparing them
  // would read the hill between those ends as barometric drift.
  assert.deepEqual(
    collectRevisits([
      pass(1, "forward", 0, [[0, 100], [15, 105], [30, 110]]),
      pass(1, "backward", 40, [[0, 100], [15, 105], [30, 110]]),
    ]),
    [],
  );
});

test("different segments are not a revisit, however alike they read", () => {
  assert.deepEqual(
    collectRevisits([
      pass(1, "forward", 0, [[0, 100], [15, 101]]),
      pass(2, "forward", 40, [[0, 100], [15, 101]]),
    ]),
    [],
  );
});

test("buckets only one pass touched are ignored", () => {
  // A second pass that overshoots the first contributes nothing from the
  // ground the first never covered -- there is no earlier reading to compare
  // it against, and using one would compare two different places.
  const revisits = collectRevisits([
    pass(1, "forward", 0, [[0, 100], [15, 101]]),
    pass(1, "forward", 40, [[0, 102], [15, 103], [30, 150], [45, 150]]),
  ]);
  assert.equal(revisits.length, 1);
  assert.equal(revisits[0].buckets, 2);
  assert.equal(revisits[0].riseM, 2);
});

test("the earlier pass is the early one, whatever order the runs arrive in", () => {
  // Runs come off the matcher in the order they were ridden, but nothing in
  // the type says so, and the sign of every rise depends on getting this right:
  // reversed, a rising barometer would be corrected as a falling one.
  const revisits = collectRevisits([
    pass(1, "forward", 40, [[0, 105]]),
    pass(1, "forward", 0, [[0, 100]]),
  ]);
  assert.equal(revisits.length, 1);
  assert.equal(revisits[0].earlyAtMs, 0);
  assert.equal(revisits[0].lateAtMs, 40 * MINUTE);
  assert.equal(revisits[0].riseM, 5, "the ride read 5m higher the second time");
});

test("REGRESSION: three passes over one block are TWO increments, not three", () => {
  // This test previously asserted three, with a comment calling each pair "a
  // separate observation". That is false, and it is how the defect reached
  // review: the 0->60 rise is arithmetically the 0->30 rise plus the 30->60
  // rise, so it is a restatement of the other two and carries no new
  // information about the barometer. N passes hold N-1 increments; pairing them
  // every way produces N(N-1)/2 numbers, and the extra ones exist only to pad a
  // quorum. Three passes over a single 15m cell used to clear a quorum of three.
  const revisits = collectRevisits([
    pass(1, "forward", 0, [[0, 100]]),
    pass(1, "forward", 30, [[0, 102]]),
    pass(1, "forward", 60, [[0, 104]]),
  ]);
  assert.equal(revisits.length, 2);
  const spans = revisits
    .map((r) => [(r.lateAtMs - r.earlyAtMs) / MINUTE, r.riseM] as const)
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(spans.map(([minutes]) => minutes), [30, 30]);
  // A steady 4m/h, and now both observations are of disjoint, abutting stretches
  // of time -- which is what makes them independent.
  for (const [minutes, rise] of spans) assert.ok(Math.abs(rise / (minutes / 60) - 4) < 1e-9);
  const starts = revisits.map((r) => r.earlyAtMs / MINUTE).sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 30], "the increments chain rather than overlap");
});

test("passes are paired in time order, not in arrival order", () => {
  // collectRevisits is handed runs grouped per segment, and nothing promises
  // they arrive chronologically. Adjacency has to be decided on the clock, or a
  // shuffled input pairs passes that are not neighbours and silently invents the
  // overlapping comparisons the rule above exists to remove.
  const revisits = collectRevisits([
    pass(1, "forward", 60, [[0, 104]]),
    pass(1, "forward", 0, [[0, 100]]),
    pass(1, "forward", 30, [[0, 102]]),
  ]);
  assert.equal(revisits.length, 2);
  const spans = revisits
    .map((r) => [r.earlyAtMs / MINUTE, r.lateAtMs / MINUTE])
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(spans, [[0, 30], [30, 60]]);
});

test("REGRESSION: a GPS pass and a barometric pass are not a revisit", () => {
  // Session 76, in miniature. Two laps of one trail, the first recorded on GPS
  // altitude because the screen was locked and expo-sensors had stopped
  // delivering, the second on the barometer. The difference between them is the
  // offset between two sensors, and because GPS vertical error moves with
  // satellite geometry it varies along the route -- so it reads as a drift that
  // grows with distance instead of with time. On the real ride that produced
  // rises from -3.49m to -17.96m across gaps that were all 31 to 32 minutes, and
  // a -25.46 m/h fit asking to tilt the ride by 20m.
  assert.deepEqual(
    collectRevisits([
      pass(1, "forward", 0, [[0, 100], [15, 101]], "gps"),
      pass(1, "forward", 40, [[0, 102], [15, 103]], "barometer"),
    ]),
    [],
  );

  // The same two passes on one instrument are a revisit, so this is measuring
  // the source rule and not something else that also refuses.
  assert.equal(
    collectRevisits([
      pass(1, "forward", 0, [[0, 100], [15, 101]], "barometer"),
      pass(1, "forward", 40, [[0, 102], [15, 103]], "barometer"),
    ]).length,
    1,
  );
});

test("a pass that changed sensor part way through is not usable either", () => {
  // Nothing can be attributed to an instrument here, so it is no use as either
  // half of a comparison -- and it must not silently pair with the run beside it.
  assert.deepEqual(
    collectRevisits([
      pass(1, "forward", 0, [[0, 100]], "mixed"),
      pass(1, "forward", 40, [[0, 102]], "barometer"),
      pass(1, "forward", 80, [[0, 104]], "mixed"),
    ]),
    [],
  );
});

test("a pure-GPS ride measures no drift, however tidy its revisits look", () => {
  // Matching sources is necessary and not sufficient. Two GPS-altitude passes
  // agree on their instrument and still have no barometer in the loop, so there
  // is no pressure drift to find -- what a fit would read instead is GPS
  // vertical error moving between the two moments, since the satellite
  // constellation over half an hour is not the one at the start.
  //
  // This is session 76's near miss. Its two laps straddled a source switch and
  // were caught by the matching rule; had both fallen inside the GPS stretch,
  // nothing but this would have stopped a confident ramp built on constellation
  // wander.
  assert.deepEqual(
    collectRevisits([
      pass(1, "forward", 0, [[0, 100]], "gps"),
      pass(1, "forward", 40, [[0, 102]], "gps"),
      pass(2, "forward", 5, [[0, 200]], "gps"),
      pass(2, "forward", 45, [[0, 202]], "gps"),
    ]),
    [],
  );
});

test("rides older than the elevation_source column measure no drift either", () => {
  // Every row is null on rides recorded before the column existed, so those
  // rides cannot show they had a working barometer -- and a drift fit is a claim
  // about one. Excluding them is the reluctant half of the rule above: it costs
  // the whole pre-column archive, and the alternative is fitting a pressure
  // correction to rides that may have had no pressure reading in them.
  //
  // They keep the single number, which is what they have always had, so nothing
  // regresses. This test exists so that a future reader changing the rule sees
  // the cost stated rather than discovering it.
  assert.deepEqual(
    collectRevisits([
      pass(1, "forward", 0, [[0, 100]], null),
      pass(1, "forward", 40, [[0, 102]], null),
    ]),
    [],
  );
});

test("a revisit records the street it was measured on", () => {
  // fitDriftRate refuses a quorum that is one street seen repeatedly, so the
  // site has to survive the trip out of here.
  const revisits = collectRevisits([
    pass(7, "forward", 0, [[0, 100]]),
    pass(7, "forward", 40, [[0, 102]]),
  ]);
  assert.equal(revisits.length, 1);
  assert.equal(revisits[0].segmentId, 7);
});

test("revisits on different segments both count", () => {
  // The quorum is about independent comparisons, and two separate streets
  // crossed twice each are exactly that.
  const revisits = collectRevisits([
    pass(1, "forward", 0, [[0, 100]]),
    pass(2, "forward", 5, [[0, 200]]),
    pass(1, "forward", 40, [[0, 102]]),
    pass(2, "forward", 45, [[0, 202]]),
  ]);
  assert.equal(revisits.length, 2);
  for (const r of revisits) assert.equal(r.riseM, 2);
});

test("a ride that never crosses its own path measures no drift at all", () => {
  // The common case, and the reason most rides keep the single number: a
  // straight there-and-somewhere-else ride has nothing to compare.
  assert.deepEqual(
    collectRevisits([
      pass(1, "forward", 0, [[0, 100], [15, 101]]),
      pass(2, "forward", 10, [[0, 102], [15, 103]]),
      pass(3, "forward", 20, [[0, 104], [15, 105]]),
    ]),
    [],
  );
});

// --- The production mapping, which had no coverage at all --------------------
//
// Every test above hands `collectRevisits` a literal `elevationSource` and
// `siteKey`. That is the right shape for testing what collectRevisits DOES with
// them, and it meant the two functions that compute them in `processSession`
// were never exercised: a review mutated both and the whole suite stayed green.
//
// Both are the production half of a rule the reviews found defects in twice, so
// an untested mapping here defeats a tested rule one level up. The instrument
// rule is the one that caught session 76 actively corrupting a real ride.

test("a run's instrument is the one every sample agrees on", () => {
  const samples = (sources: Array<"barometer" | "gps" | null>) =>
    sources.map((elevationSource, i) => ({
      id: i,
      sessionId: 1,
      recordedAt: new Date(i * 1000).toISOString(),
      lat: 38.8,
      lon: -104.8,
      elevationM: 1800,
      elevationSource,
    })) as never[];

  assert.equal(runElevationSource(samples(["barometer", "barometer", "barometer"])), "barometer");
  assert.equal(runElevationSource(samples(["gps", "gps"])), "gps");
});

test("a run whose sensor changed part way through is 'mixed', in either order", () => {
  // expo-sensors stops delivering barometer readings when the screen locks, so
  // a ride falls back to GPS altitude mid-way and back again. A run straddling
  // that switch is attributable to no instrument, and `collectRevisits` refuses
  // anything that is not wholly on the barometer.
  //
  // Both orders, because a loop that only ever compared against `samples[0]`
  // would pass one of them and fail the other, and an implementation that
  // compared each sample against its predecessor would pass both while missing
  // barometer -> gps -> barometer.
  const samples = (sources: Array<"barometer" | "gps" | null>) =>
    sources.map((elevationSource, i) => ({
      id: i,
      sessionId: 1,
      recordedAt: new Date(i * 1000).toISOString(),
      lat: 38.8,
      lon: -104.8,
      elevationM: 1800,
      elevationSource,
    })) as never[];

  assert.equal(runElevationSource(samples(["barometer", "gps"])), "mixed");
  assert.equal(runElevationSource(samples(["gps", "barometer"])), "mixed");
  assert.equal(
    runElevationSource(samples(["barometer", "gps", "barometer"])),
    "mixed",
    "a sensor that came back is still a run that changed sensor",
  );
  assert.equal(
    runElevationSource(samples(["barometer", "barometer", "gps", "barometer"])),
    "mixed",
    "and the switch may be anywhere but the first sample",
  );
});

test("null is its own instrument, and it matches itself", () => {
  // Rides recorded before session_samples.elevation_source existed are all
  // null. Two passes from one such ride DID come from the same instrument even
  // though the row cannot say which, so null has to match null rather than
  // poisoning the run to "mixed" -- otherwise every pre-column ride is barred
  // from the drift fit forever for a difference that does not exist within any
  // one of them. They are then excluded anyway, one level up in
  // `collectRevisits`, because they cannot show they had a working barometer.
  const samples = (sources: Array<"barometer" | "gps" | null>) =>
    sources.map((elevationSource, i) => ({
      id: i,
      sessionId: 1,
      recordedAt: new Date(i * 1000).toISOString(),
      lat: 38.8,
      lon: -104.8,
      elevationM: 1800,
      elevationSource,
    })) as never[];

  assert.equal(runElevationSource(samples([null, null, null])), null);
  assert.equal(runElevationSource(samples([null, "barometer"])), "mixed");
  // An empty run is "mixed" rather than null: there is no evidence of any
  // instrument, and "mixed" is the value collectRevisits refuses. Defaulting to
  // null here would put it in the same bucket as the pre-column rides, which is
  // a claim about the data rather than an absence of one.
  assert.equal(runElevationSource([]), "mixed");
});

test("a site is the street, so the pieces one street is cut into share it", () => {
  // The rule behind MIN_REVISIT_SITES, on the production side. A segments row is
  // one OSM way split at every intersection node and cut again into piece_index
  // slices, so a single named street is many rows -- and session 76 reported
  // "15 distinct sites" that were fifteen consecutive pieces of Culebras Trail.
  assert.equal(
    siteKeyFor({ streetName: "Culebras Trail", osmWayId: 111 }),
    siteKeyFor({ streetName: "Culebras Trail", osmWayId: 222 }),
    "two pieces of one named street are one site, whatever their way ids",
  );
  assert.notEqual(
    siteKeyFor({ streetName: "Culebras Trail", osmWayId: 111 }),
    siteKeyFor({ streetName: "Ute Valley Regional Trail", osmWayId: 111 }),
  );
});

test("an unnamed segment falls back to its way, not to a shared blank", () => {
  // The case that decides whether the gate works on trails and connectors,
  // which is where this archive's revisits actually are. Collapsing every
  // unnamed segment to one key would make them all one site and refuse every
  // quorum; keying them by name would make each piece its own site and refuse
  // nothing. The way id is the middle: consecutive pieces of one unnamed trail
  // share it, and two different connectors do not.
  assert.equal(
    siteKeyFor({ streetName: null, osmWayId: 900 }),
    siteKeyFor({ streetName: null, osmWayId: 900 }),
  );
  assert.notEqual(
    siteKeyFor({ streetName: null, osmWayId: 900 }),
    siteKeyFor({ streetName: null, osmWayId: 901 }),
    "two unnamed segments are not automatically the same place",
  );
  // Whitespace is not a name. A row of "   " would otherwise produce the key
  // `name:` and put every such segment on one site across the whole archive.
  assert.equal(
    siteKeyFor({ streetName: "   ", osmWayId: 900 }),
    siteKeyFor({ streetName: null, osmWayId: 900 }),
    "a blank name is an absent name",
  );
  // And the two key spaces cannot collide, which is what the `name:` and `way:`
  // prefixes are for and is invisible until a name collides with a way id.
  // Numbered roads make that ordinary rather than hypothetical: a segment on
  // county road "900" and an unnamed segment of way 900 are different places,
  // and without the prefixes they are one site -- so a quorum spanning both
  // would silently count as one street and be refused.
  assert.notEqual(
    siteKeyFor({ streetName: "900", osmWayId: 42 }),
    siteKeyFor({ streetName: null, osmWayId: 900 }),
    "a street named 900 is not way 900",
  );
});

test("a sample with no elevation_source field at all is not its own instrument", () => {
  // Why `?? null` rather than a bare comparison. The column is always selected
  // in `processSession`, so a row from there carries null and not undefined --
  // but this function is exported and a caller assembling samples by hand can
  // omit the field. Without the fold, `undefined !== null` and a run of
  // otherwise-identical pre-column samples reports "mixed", which silently
  // removes rides from the drift fit for a difference that is not in the data.
  const withField = [
    { elevationSource: null },
    { elevationSource: null },
  ] as never[];
  const withoutField = [{}, {}] as never[];
  assert.equal(runElevationSource(withField), null);
  assert.equal(
    runElevationSource(withoutField),
    null,
    "an absent field and an explicit null are the same absence of a sensor name",
  );
  // Mixing the two spellings is still one instrument, which is the case a bare
  // `!==` gets wrong.
  assert.equal(runElevationSource([{ elevationSource: null }, {}] as never[]), null);
});
