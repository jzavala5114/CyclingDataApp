import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collectRevisits } from "./sessionProcessor.js";
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
