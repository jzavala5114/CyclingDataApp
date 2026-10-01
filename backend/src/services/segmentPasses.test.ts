import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findPasses,
  CORRIDOR_M,
  MIN_PASS_M,
  RETRACE_M,
  MAX_PASS_GAP_S,
  type ProjectedFix,
} from "./segmentPasses.js";
import { MIN_SPAN_M } from "./elevationAggregator.js";
import { MAX_MATCH_DISTANCE_M, STITCH_WINDOW_S } from "./segmentMatcher.js";

// This detector is the independent witness: it decides what the rider did so
// the matcher can be judged against it. If it is wrong, every conclusion drawn
// from it is wrong in the same direction and nothing else would notice -- which
// is exactly how the last two geometry mistakes in this project got shipped.

/** Fixes one second apart, walking the given distances along the centreline. */
const walk = (distances: number[], offsetM = 0): ProjectedFix[] =>
  distances.map((distanceM, i) => ({ atMs: i * 1000, distanceM, offsetM }));

test("a single traversal is one forward pass", () => {
  const passes = findPasses(walk([0, 20, 40, 60, 80, 100]));
  assert.equal(passes.length, 1);
  assert.equal(passes[0]!.direction, "forward");
  assert.equal(passes[0]!.fromM, 0);
  assert.equal(passes[0]!.toM, 100);
  assert.equal(passes[0]!.spanM, 100);
  assert.equal(passes[0]!.fixes, 6);
});

test("travelling the other way is one backward pass", () => {
  const passes = findPasses(walk([100, 80, 60, 40, 20, 0]));
  assert.equal(passes.length, 1);
  assert.equal(passes[0]!.direction, "backward");
  assert.equal(passes[0]!.spanM, 100);
});

test("THE CASE THIS EXISTS FOR: out and back is two passes, one each way", () => {
  const passes = findPasses(walk([0, 25, 50, 75, 100, 75, 50, 25, 0]));
  assert.equal(passes.length, 2);
  assert.deepEqual(
    passes.map((p) => p.direction),
    ["forward", "backward"],
  );
  assert.equal(passes[0]!.fromM, 0);
  assert.equal(passes[0]!.toM, 100);
  assert.equal(passes[1]!.fromM, 100);
  assert.equal(passes[1]!.toM, 0);
});

test("the turn is reported at the far point, not where the retrace was noticed", () => {
  // If the pass closed at the fix that triggered the turn, every out-and-back
  // would report both passes short by a retrace, and the far end of the segment
  // would look permanently unvisited.
  const passes = findPasses(walk([0, 50, 100, 80, 40, 0]));
  assert.equal(passes[0]!.toM, 100, "the outbound pass reaches the far point");
  assert.equal(passes[1]!.fromM, 100, "and the return starts from it");
});

test("jitter at a light is not a turn", () => {
  // A stationary rider's projection wanders by a few metres. Below the retrace
  // threshold that must not split one traversal into three.
  const passes = findPasses(walk([0, 30, 34, 31, 35, 33, 60, 90]));
  assert.equal(passes.length, 1);
  assert.equal(passes[0]!.direction, "forward");
  assert.equal(passes[0]!.spanM, 90);
});

test("BOUNDARY: the retrace threshold is one bucket, and it bites", () => {
  assert.equal(RETRACE_M, 15);
  // Coming back 14m is noise, 16m is a turn. Both legs have to clear MIN_PASS_M
  // to be reported, so the fixtures go far enough either side.
  const noise = findPasses(walk([0, 100, 86, 140]));
  assert.equal(noise.length, 1, "a 14m retrace is noise");
  const turn = findPasses(walk([0, 100, 84, 40, 0]));
  assert.equal(turn.length, 2, "a 16m retrace starts a return");
});

test("BOUNDARY: a pass must cover MIN_PASS_M, which is the gate's own span", () => {
  assert.equal(MIN_PASS_M, MIN_SPAN_M, "a detected pass is one the gate would accept");
  assert.equal(MIN_PASS_M, 25);
  assert.equal(findPasses(walk([0, 20, 24])).length, 0, "24m is not a pass");
  assert.equal(findPasses(walk([0, 20, 25])).length, 1, "25m is");
});

test("fixes outside the corridor are not on this segment at all", () => {
  assert.equal(CORRIDOR_M, MAX_MATCH_DISTANCE_M, "the matcher's own corridor");
  // A rider on the next street over projects onto this one perfectly well.
  // Without the corridor every parallel street would show a pass, and the whole
  // measurement would be of the projection rather than of the ride.
  assert.equal(findPasses(walk([0, 50, 100], CORRIDOR_M + 1)).length, 0);
  assert.equal(findPasses(walk([0, 50, 100], CORRIDOR_M)).length, 1, "the boundary is inclusive");
});

test("a fix that strays out of the corridor is dropped, and the pass continues", () => {
  const fixes: ProjectedFix[] = [
    { atMs: 0, distanceM: 0, offsetM: 2 },
    { atMs: 1000, distanceM: 40, offsetM: 60 }, // a multipath spike sideways
    { atMs: 2000, distanceM: 80, offsetM: 2 },
  ];
  const passes = findPasses(fixes);
  assert.equal(passes.length, 1);
  assert.equal(passes[0]!.spanM, 80);
  assert.equal(passes[0]!.fixes, 2, "the strayed fix is not counted");
});

test("three legs: out, back, and out again", () => {
  const passes = findPasses(walk([0, 60, 120, 60, 0, 60, 120]));
  assert.deepEqual(
    passes.map((p) => p.direction),
    ["forward", "backward", "forward"],
  );
  assert.equal(passes.length, 3);
});

test("a short leg between two long ones does not become a pass", () => {
  // Out 120m, back 20m (a wrong turn, corrected), on to 150m. The 20m retrace
  // is a turn by RETRACE_M but the leg is under MIN_PASS_M, so it is not
  // reported -- while the legs either side still are.
  const passes = findPasses(walk([0, 60, 120, 100, 140, 150]));
  assert.ok(passes.every((p) => p.spanM >= MIN_PASS_M), JSON.stringify(passes));
  assert.deepEqual(passes.map((p) => p.direction), ["forward", "forward"]);
});

test("idling before setting off does not start a pass", () => {
  const passes = findPasses(walk([50, 52, 49, 51, 50, 80, 110]));
  assert.equal(passes.length, 1);
  assert.equal(passes[0]!.direction, "forward");
  assert.ok(passes[0]!.spanM >= 60, `span ${passes[0]!.spanM}`);
});

test("nothing to compare is no pass", () => {
  assert.deepEqual(findPasses([]), []);
  assert.deepEqual(findPasses(walk([42])), []);
  assert.deepEqual(findPasses(walk([42, 42, 42])), []);
});

test("non-finite projections are dropped rather than steering the answer", () => {
  const fixes: ProjectedFix[] = [
    { atMs: 0, distanceM: 0, offsetM: 1 },
    { atMs: 1000, distanceM: NaN, offsetM: 1 },
    { atMs: 2000, distanceM: 50, offsetM: NaN },
    { atMs: 3000, distanceM: 100, offsetM: 1 },
  ];
  const passes = findPasses(fixes);
  assert.equal(passes.length, 1);
  assert.equal(passes[0]!.spanM, 100);
});

test("timestamps come from the fixes that bound the pass", () => {
  const passes = findPasses(walk([0, 50, 100, 50, 0]));
  assert.equal(passes[0]!.startedMs, 0);
  assert.equal(passes[0]!.endedMs, 2000);
  assert.equal(passes[1]!.startedMs, 2000);
  assert.equal(passes[1]!.endedMs, 4000);
});

test("the thresholds are overridable, so a sweep runs through this code", () => {
  // Both have to move together below the default: see the coupling test.
  assert.equal(findPasses(walk([0, 10]), { minPassM: 5, retraceM: 5 }).length, 1);
  assert.equal(findPasses(walk([0, 10]), { minPassM: 50 }).length, 0);
  // A 10m retrace: a turn at retraceM 5, noise at 50. The fixture has to end
  // on the retrace, because a rider who really does come back 100m has turned
  // by any threshold.
  assert.equal(findPasses(walk([0, 100, 90, 85, 60, 30]), { retraceM: 5 }).length, 2);
  assert.equal(findPasses(walk([0, 100, 90]), { retraceM: 50 }).length, 1);
});

test("COUPLING: a pass shorter than the retrace is invisible however low minPassM goes", () => {
  // The direction of a leg is not known until the rider has moved retraceM, so
  // a shorter leg never establishes one. Lowering minPassM alone therefore
  // finds no more passes, which would look like "there are none" rather than
  // "this cannot see them". The defaults keep clear of it.
  assert.ok(MIN_PASS_M >= RETRACE_M, `MIN_PASS_M ${MIN_PASS_M} < RETRACE_M ${RETRACE_M}`);
  assert.equal(findPasses(walk([0, 10]), { minPassM: 1 }).length, 0, "retraceM still gates it");
  assert.equal(findPasses(walk([0, 10]), { minPassM: 1, retraceM: 1 }).length, 1);
});

test("a return twenty minutes later is a separate arrival, not an extension", () => {
  // Without the time bound the second visit's first fix sits at the same
  // distance as the first visit's last, the extreme advances straight through
  // it, and the outbound pass is reported as ending twenty minutes after it
  // really did -- which is the wrong moment to ask what the matcher was doing.
  const fixes: ProjectedFix[] = [
    { atMs: 0, distanceM: 0, offsetM: 1 },
    { atMs: 10_000, distanceM: 90, offsetM: 1 },
    // ... twenty minutes away on other streets, no fixes inside the corridor
    { atMs: 1_200_000, distanceM: 90, offsetM: 1 },
    { atMs: 1_210_000, distanceM: 0, offsetM: 1 },
  ];
  const passes = findPasses(fixes);
  assert.equal(passes.length, 2);
  assert.deepEqual(passes.map((p) => p.direction), ["forward", "backward"]);
  assert.equal(passes[0]!.endedMs, 10_000, "the outbound pass ends when it ended");
  assert.equal(passes[1]!.startedMs, 1_200_000, "and the return starts when the rider came back");
});

test("BOUNDARY: the pass gap is the matcher's stitch window, and it bites", () => {
  assert.equal(MAX_PASS_GAP_S, STITCH_WINDOW_S, "one window for one question");
  const at = (s: number, d: number): ProjectedFix => ({ atMs: s * 1000, distanceM: d, offsetM: 1 });
  // Inside the window: a dropout mid-traversal, still one pass.
  assert.equal(findPasses([at(0, 0), at(MAX_PASS_GAP_S, 100)]).length, 1);
  // Past it: two arrivals, and the second leg here goes the other way.
  const split = findPasses([at(0, 0), at(MAX_PASS_GAP_S + 1, 100), at(MAX_PASS_GAP_S + 20, 0)]);
  assert.equal(split.length, 1, "the first leg never reached minPassM before the silence");
  assert.equal(split[0]!.direction, "backward");
});
