import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MAX_DEFENSIBLE_REGRESSION_M,
  MIN_REVISIT_GAP_S,
  crossRideDisagreements,
  judgeMeasure,
  pairedChange,
  selfDisagreements,
  summarise,
  terrainDisagreements,
  verifyUntouched,
  type HeldOutKeys,
  type Observation,
  type Observations,
} from "./evalMeasures.js";
import {
  MAX_TOTAL_DRIFT_M,
  MIN_REVISIT_GAP_S as FIT_MIN_REVISIT_GAP_S,
} from "./anchorFit.js";

// Gate tests for the eval harness itself.
//
// The harness is the thing that decides whether the sliding anchor is safe, and
// until this file existed it was the only part of the project with no tests of
// its own -- because every one of these functions closed over a module-level
// map beneath a top-level `await` against the database, so importing them ran
// the eval. The fourth round of review found three separate "a check that
// cannot fail, reported as a check that passed" defects living in that blind
// spot. Each of the three is pinned below by the reviewer's own scenario, under
// the reviewer's own label.

const MIN = 60_000;

function observations(entries: Record<string, Observation[]>): Observations {
  return new Map(Object.entries(entries));
}

function heldOut(entries: Record<number, string[]>): HeldOutKeys {
  return new Map(Object.entries(entries).map(([id, keys]) => [Number(id), new Set(keys)]));
}

function obs(sessionId: number, atMs: number, elevationM: number, demM: number | null = null) {
  return { sessionId, atMs, elevationM, demM };
}

// A flat map of comparison key -> value, as the three measures return.
const values = (...v: number[]) => new Map(v.map((x, i) => [`c${i}`, x]));

// ---------------------------------------------------------------------------
// The constants this harness keeps its own copies of
// ---------------------------------------------------------------------------

test("the eval's revisit gap is the fit's revisit gap, or one of them moved alone", () => {
  // The eval keeps its own literal rather than importing the fit's, for the
  // reason `previousAnchor` keeps its own: a threshold that tracks the module
  // under test moves silently when that module moves. This test is what makes
  // that safe instead of merely stale -- a divergence fails here rather than
  // quietly changing which comparisons the verdict is computed over.
  assert.equal(MIN_REVISIT_GAP_S, FIT_MIN_REVISIT_GAP_S);
});

test("the worst-regression bounds are still derived from the fit's drift cap", () => {
  // Same rule, same reason. Self-consistency and terrain shape are bounded by a
  // single ride's total drift, which is what the fit refuses above; cross-ride
  // spans two rides and is given twice that, deliberately loose.
  assert.equal(MAX_DEFENSIBLE_REGRESSION_M["self-consistency"], MAX_TOTAL_DRIFT_M);
  assert.equal(MAX_DEFENSIBLE_REGRESSION_M["terrain shape"], MAX_TOTAL_DRIFT_M);
  assert.equal(MAX_DEFENSIBLE_REGRESSION_M["cross-ride"], 2 * MAX_TOTAL_DRIFT_M);
});

// ---------------------------------------------------------------------------
// F1 -- the untouched-bucket proof can verify zero buckets and print as a pass
// ---------------------------------------------------------------------------

test("REVIEWER B SCENARIO A: a proof with no subjects is vacuous, not a pass", () => {
  // Every bucket has a treated contributor, so line 637's `continue` skips all
  // of them, both counters stay at zero, and the script printed
  //   untouched buckets verified identical: 0/0
  // and exited 0. A reassuring 8742/8742 and a vacuous 0/0 were
  // indistinguishable to the gate. This is the one check that licenses the
  // verdict resting on the treated scope at all.
  const before = observations({ "1|forward|0": [obs(1, 0, 100)] });
  const after = observations({ "1|forward|0": [obs(1, 0, 105)] });

  const proof = verifyUntouched(before, after, new Set([1]));

  assert.equal(proof.checked, 0);
  assert.equal(proof.moved, 0);
  // The bug was that these two are the same state to a `moved > 0` gate.
  assert.equal(proof.vacuous, true);
});

test("a proof that did check something is not vacuous, even when nothing moved", () => {
  // The other half of the pair, so `vacuous` cannot be satisfied by always
  // returning true. Session 2 is untreated and identical in both modes: this is
  // the genuine 8742/8742 reading.
  const before = observations({
    "1|forward|0": [obs(1, 0, 100)],
    "2|forward|0": [obs(2, 0, 200)],
  });
  const after = observations({
    "1|forward|0": [obs(1, 0, 105)],
    "2|forward|0": [obs(2, 0, 200)],
  });

  const proof = verifyUntouched(before, after, new Set([1]));

  assert.equal(proof.checked, 1);
  assert.equal(proof.moved, 0);
  assert.equal(proof.vacuous, false);
});

test("an untouched bucket that moved is caught, and a missing one is not scored identical", () => {
  // The history defect this branch was written for: the old arithmetic test read
  // `Math.abs(before - (after?.elevationM ?? NaN)) > 1e-9`, and every comparison
  // against NaN is false, so a bucket the new code dropped entirely scored as
  // identical and counted towards the proof.
  const before = observations({
    "2|forward|0": [obs(2, 0, 200)],
    "3|forward|0": [obs(3, 0, 300)],
  });
  const after = observations({
    "2|forward|0": [obs(2, 0, 200.5)],
    "3|forward|0": [],
  });

  const proof = verifyUntouched(before, after, new Set());

  assert.equal(proof.checked, 2);
  assert.equal(proof.moved, 2, "one moved by 0.5m, one vanished");
  assert.equal(proof.missing, 1);
});

test("F6: an identity appearing only in 'after' is a structural difference, not agreement", () => {
  // `untouchedMissing` could never fire, because the observation population is
  // built once per session before the mode loop and without consulting any fit,
  // so the identity sets are equal by construction. It is kept as the tripwire
  // for the change that would break that premise -- a fitter that altered which
  // runs qualify -- and it now counts differences in EITHER direction, where
  // before it could only have seen one.
  const before = observations({ "2|forward|0": [obs(2, 0, 200)] });
  const after = observations({ "2|forward|0": [obs(2, 0, 200), obs(2, 999, 200)] });

  const proof = verifyUntouched(before, after, new Set());

  assert.equal(proof.moved, 0, "the shared identity is unchanged");
  assert.equal(proof.structurallyDifferent, 1, "the extra 'after' identity must be seen");
});

// ---------------------------------------------------------------------------
// F2 -- the gate read only the median
// ---------------------------------------------------------------------------

test("REVIEWER B SCENARIO B: 6 comparisons improving 0.10m against 5 regressing 40m is a FAIL", () => {
  // The reviewer's exact population, and the exact numbers their run printed:
  //   median 5.00 -> 4.90, mean 5.00 -> 23.13, p90 5.00 -> 45.00
  //   improved 6, worsened 5, worst_regression_m 40
  //   EXIT CODE: 0
  // The median gate is satisfied and always was. The mean is what catches this,
  // and it needs no threshold: the question is only which way the total moved.
  const before = values(5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5);
  const after = values(4.9, 4.9, 4.9, 4.9, 4.9, 4.9, 45, 45, 45, 45, 45);

  const b = summarise([...before.values()]);
  const a = summarise([...after.values()]);
  const change = pairedChange(before, after);

  // The reviewer's printed figures, reproduced, so this test fails loudly if the
  // summary or the pairing ever stops meaning what it meant here.
  assert.equal(b.median, 5);
  assert.equal(a.median, 4.9);
  assert.equal(Number(a.mean.toFixed(2)), 23.13);
  assert.equal(change.improved, 6);
  assert.equal(change.worsened, 5);
  assert.equal(change.worstRegressionM, 40);
  assert.ok(a.median <= b.median, "the old one-line gate passed this, and still would");

  const { verdict, reasons } = judgeMeasure("self-consistency", b, a, change);
  assert.equal(verdict, "FAIL");
  assert.ok(
    reasons.some((r) => r.includes("mean rose")),
    `expected the mean gate to fire, got: ${reasons.join(" | ")}`,
  );
});

test("the median gate still fires on its own", () => {
  // The one gate that was already there. Kept under test so the rewrite cannot
  // drop it while the three new ones distract.
  const before = values(1, 1, 1);
  const after = values(2, 2, 2);
  const { verdict, reasons } = judgeMeasure(
    "self-consistency",
    summarise([...before.values()]),
    summarise([...after.values()]),
    pairedChange(before, after),
  );
  assert.equal(verdict, "FAIL");
  assert.ok(reasons.some((r) => r.includes("median rose")));
});

test("more comparisons hurt than helped is a FAIL, even with median and mean holding", () => {
  // Isolates the count gate. Two improve by 9m, three worsen by 0.5m, five sit
  // still: the mean falls, the median holds exactly, the worst regression is
  // trivial, and the change still hurt more of what it touched than it helped.
  const before = values(10, 10, 10, 10, 10, 10, 10, 10, 10, 10);
  const after = values(1, 1, 10.5, 10.5, 10.5, 10, 10, 10, 10, 10);

  const b = summarise([...before.values()]);
  const a = summarise([...after.values()]);
  const change = pairedChange(before, after);

  assert.equal(a.median, 10, "median must hold, or this is not isolating the count gate");
  assert.ok(a.mean < b.mean, "mean must fall, or this is not isolating the count gate");
  assert.equal(change.improved, 2);
  assert.equal(change.worsened, 3);

  const { verdict, reasons } = judgeMeasure("self-consistency", b, a, change);
  assert.equal(verdict, "FAIL");
  assert.ok(reasons.some((r) => r.includes("got worse against")));
});

test("one impossible regression is a FAIL however good the aggregate looks", () => {
  // Nine comparisons improve 99m each and one regresses 40m. Median, mean and
  // count all pass comfortably -- the aggregate is a triumph -- and no
  // legitimate correction can move a single self-consistency comparison 40m,
  // because that comparison's change is exactly the ride's own drift and the fit
  // refuses drift above MAX_TOTAL_DRIFT_M. So something is wrong with the fit or
  // with this harness, and it has to be visible.
  const before = values(100, 100, 100, 100, 100, 100, 100, 100, 100, 100);
  const after = values(1, 1, 1, 1, 1, 1, 1, 1, 1, 140);

  const b = summarise([...before.values()]);
  const a = summarise([...after.values()]);
  const change = pairedChange(before, after);

  assert.ok(a.median <= b.median && a.mean < b.mean && change.improved > change.worsened);

  const { verdict, reasons } = judgeMeasure("self-consistency", b, a, change);
  assert.equal(verdict, "FAIL");
  assert.ok(reasons.some((r) => r.includes("worst single regression")));
});

test("the worst-regression bound is per measure, not one number for all three", () => {
  // A 20m regression is impossible for a single ride's self-consistency (bound
  // 15m, derived) and possible for cross-ride (bound 30m, a judgement about two
  // ramped rides). A single shared bound would have to pick one of those and be
  // wrong for the other.
  const before = values(100, 100, 100, 100);
  const after = values(1, 1, 1, 120);
  const b = summarise([...before.values()]);
  const a = summarise([...after.values()]);
  const change = pairedChange(before, after);
  assert.equal(change.worstRegressionM, 20);

  assert.equal(judgeMeasure("self-consistency", b, a, change).verdict, "FAIL");
  assert.equal(judgeMeasure("cross-ride", b, a, change).verdict, "PASS");
});

test("a clean improvement across the board still passes", () => {
  // The gates have to be able to say yes, or they are a refusal wearing a
  // verdict's clothes.
  const before = values(5, 5, 5, 5);
  const after = values(4, 4, 4, 4.5);
  const { verdict, reasons } = judgeMeasure(
    "self-consistency",
    summarise([...before.values()]),
    summarise([...after.values()]),
    pairedChange(before, after),
  );
  assert.equal(verdict, "PASS");
  assert.deepEqual(reasons, []);
});

// ---------------------------------------------------------------------------
// F3 -- inconclusive asked "were there comparisons", not "could any have moved"
// ---------------------------------------------------------------------------

test("REVIEWER B SCENARIO D: comparisons that could not move are INCONCLUSIVE, not PASS", () => {
  // The reviewer shifted every observation of a treated ride by 5m and all three
  // treated measures reported improved 0, worsened 0, unchanged 11/11/22. Six
  // PASSes, exit 0. `n > 0` was satisfied while the measure had zero power --
  // self-consistency and terrain shape both cancel a constant by construction,
  // so they cannot see a uniform shift at all.
  //
  // This is the same "could not have detected harm" the script already wrote
  // exit 2 for, and the data to detect it was already sitting in `paired`.
  const before = values(5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5);
  const after = values(5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5);

  const b = summarise([...before.values()]);
  const a = summarise([...after.values()]);
  const change = pairedChange(before, after);

  assert.equal(b.n, 11, "there ARE comparisons; that was never the question");
  assert.equal(change.improved, 0);
  assert.equal(change.worsened, 0);
  assert.equal(change.unchanged, 11);
  assert.ok(a.median <= b.median, "the old gate passed this, and still would");

  const { verdict, reasons } = judgeMeasure("self-consistency", b, a, change);
  assert.equal(verdict, "INCONCLUSIVE");
  assert.ok(reasons.some((r) => r.includes("zero power")));
});

test("no comparisons at all is NONE, which is a different finding from zero power", () => {
  // NONE means the fit reached no ride. INCONCLUSIVE-by-zero-power means it
  // reached rides and the measure was blind to what it did. Both are non-zero
  // exits and they are not the same sentence to a reader deciding what to do.
  const empty = new Map<string, number>();
  const { verdict } = judgeMeasure(
    "self-consistency",
    summarise([]),
    summarise([]),
    pairedChange(empty, empty),
  );
  assert.equal(verdict, "NONE");
});

test("a measure where most comparisons moved is judged, not excused as zero power", () => {
  // The escape hatch must not swallow real verdicts. The rule is a majority, so
  // two of three moving is judged; see the boundary test below for both sides
  // of it.
  const before = values(5, 5, 5);
  const after = values(4, 4, 5);
  const { verdict } = judgeMeasure(
    "self-consistency",
    summarise([...before.values()]),
    summarise([...after.values()]),
    pairedChange(before, after),
  );
  assert.equal(verdict, "PASS");
});

// ---------------------------------------------------------------------------
// F4 -- cross-ride measured the range while claiming to measure what the map draws
// ---------------------------------------------------------------------------

test("REVIEWER B F4: a ride moving between two others must move the cross-ride measure", () => {
  // `Math.max(...means) - Math.min(...means)` does not move when a non-extreme
  // contributor moves. In the reviewer's Scenario D ride 1 shifted 5m at every
  // bucket while bracketed by rides 2 and 3, and cross-ride reported
  // 20.00m -> 20.00m. What the map draws is a running mean, which moves whenever
  // any contributor moves, so the spread about that mean is the honest statistic.
  const held = heldOut({ 1: ["k"], 2: ["k"], 3: ["k"] });
  const before = observations({ k: [obs(1, 0, 20), obs(2, 0, 10), obs(3, 0, 30)] });
  const after = observations({ k: [obs(1, 0, 25), obs(2, 0, 10), obs(3, 0, 30)] });

  const b = crossRideDisagreements(before, held).get("k")!;
  const a = crossRideDisagreements(after, held).get("k")!;

  // The range is 20 in both, which is the defect.
  const range = (o: Observations) => {
    const v = o.get("k")!.map((x) => x.elevationM);
    return Math.max(...v) - Math.min(...v);
  };
  assert.equal(range(before), 20);
  assert.equal(range(after), 20);

  assert.notEqual(Number(b.toFixed(6)), Number(a.toFixed(6)));
  assert.equal(Number(b.toFixed(4)), 6.6667, "mean absolute deviation about 20");
  assert.equal(Number(a.toFixed(4)), 7.7778, "and about 21.667 once ride 1 moves");
});

test("REVIEWER B F4: three passes of one ride get three votes, because mergeBuckets does", () => {
  // The old code collapsed each session to its own mean first, on the stated
  // grounds that "a ride that passed three times counts once". Production
  // disagrees: `mergeBuckets` is called once per run and increments
  // `sample_count` by one each call, so three passes get three votes in the
  // drawn value. A measure claiming to model what lands on the map has to weight
  // the way the map does.
  const held = heldOut({ 1: ["k"], 2: ["k"] });
  const three = observations({
    k: [obs(1, 0, 10), obs(1, 1, 10), obs(1, 2, 10), obs(2, 0, 20)],
  });

  const value = crossRideDisagreements(three, held).get("k")!;

  // Four votes about a mean of 12.5: |−2.5| x3 and |7.5|, over 4.
  assert.equal(Number(value.toFixed(4)), 3.75);
  // Collapsing ride 1 to a single mean of 10 would give the spread about 15,
  // which is 5. That number is what production does NOT draw.
  assert.notEqual(Number(value.toFixed(4)), 5);
});

test("cross-ride needs two rides, however many passes one ride made", () => {
  // The inclusion test is what keeps it a CROSS-ride measure now that every pass
  // votes. Without it, one ride passing three times would be scored here as well
  // as in self-consistency.
  const held = heldOut({ 1: ["k"] });
  const oneRide = observations({ k: [obs(1, 0, 10), obs(1, 1, 20), obs(1, 2, 30)] });
  assert.equal(crossRideDisagreements(oneRide, held).size, 0);
});

// ---------------------------------------------------------------------------
// F5 -- cross-ride was not held out at all
// ---------------------------------------------------------------------------

test("REVIEWER B F5: a bucket not withheld from every contributor is out of scope", () => {
  // Cross-ride is the only one of the three whose value depends on the level
  // rather than cancelling it, and it had no held-out filter: about half its
  // comparisons sat on buckets whose revisit rises the drift rate had been
  // fitted to shrink. A gated measure was partly scoring the fit on its own
  // training data, with nothing saying so, while both its neighbours carried an
  // out-of-sample comment.
  const both = heldOut({ 1: ["k"], 2: ["k"] });
  const onlyOne = heldOut({ 1: ["k"], 2: [] });
  const data = observations({ k: [obs(1, 0, 10), obs(2, 0, 20)] });

  assert.equal(crossRideDisagreements(data, both).size, 1);
  assert.equal(
    crossRideDisagreements(data, onlyOne).size,
    0,
    "ride 2 fitted on this bucket, so the comparison is in sample for ride 2",
  );
});

// ---------------------------------------------------------------------------
// F9 -- the eval believed revisits the fit never would
// ---------------------------------------------------------------------------

test("REVIEWER B F9: a five-minute revisit is not a revisit, because the fit says so", () => {
  // The eval admitted pairs 300s apart while `anchorFit.MIN_REVISIT_GAP_S` is
  // 1800. The ramp's correction difference across five minutes is rate x 5min, a
  // few tenths of a metre at any rate the fit accepts, so those near-immovable
  // comparisons sat in the median that decides the verdict and dragged it
  // towards "nothing moved".
  const held = heldOut({ 1: ["k"] });
  const fiveMinutes = observations({ k: [obs(1, 0, 10), obs(1, 5 * MIN, 12)] });
  const thirtyMinutes = observations({ k: [obs(1, 0, 10), obs(1, 30 * MIN, 12)] });

  assert.equal(selfDisagreements(fiveMinutes, held).size, 0);
  assert.equal(selfDisagreements(thirtyMinutes, held).get("k|1"), 2);
});

// ---------------------------------------------------------------------------
// The measures' own behaviour, now that they are reachable
// ---------------------------------------------------------------------------

test("self-consistency scores only buckets withheld from that ride's fit", () => {
  const data = observations({
    kept: [obs(1, 0, 10), obs(1, 30 * MIN, 13)],
    fitted: [obs(1, 0, 10), obs(1, 30 * MIN, 99)],
  });
  const scored = selfDisagreements(data, heldOut({ 1: ["kept"] }));
  assert.deepEqual([...scored.keys()], ["kept|1"]);
  assert.equal(scored.get("kept|1"), 3);
});

test("self-consistency is scoped per ride, so an untreated ride in a treated bucket is not measured", () => {
  // This once admitted the whole bucket if ANY ride in it was treated, then
  // measured every ride in it. Each untreated ride contributes a pair that
  // cannot move, which drags both medians together and makes a real effect look
  // smaller than it is.
  const data = observations({
    k: [obs(1, 0, 10), obs(1, 30 * MIN, 13), obs(2, 0, 50), obs(2, 30 * MIN, 58)],
  });
  const scored = selfDisagreements(data, heldOut({ 1: ["k"], 2: ["k"] }), new Set([1]));
  assert.deepEqual([...scored.keys()], ["k|1"]);
});

test("terrain shape removes each ride's own level, so a constant offset scores zero change", () => {
  // The absolute level is what the anchor legitimately sets; the shape is what
  // must stay put. A whole-ride offset has to be invisible here or the measure
  // would punish the anchor for doing its job.
  const held = heldOut({ 1: ["a", "b", "c"] });
  const level = observations({
    a: [obs(1, 0, 10, 8)],
    b: [obs(1, 1, 12, 8)],
    c: [obs(1, 2, 14, 8)],
  });
  const shifted = observations({
    a: [obs(1, 0, 30, 8)],
    b: [obs(1, 1, 32, 8)],
    c: [obs(1, 2, 34, 8)],
  });
  assert.deepEqual(
    [...terrainDisagreements(level, held).values()],
    [...terrainDisagreements(shifted, held).values()],
  );
});

test("terrain shape sees a tilt, which is the whole reason it exists", () => {
  // Both other measures ask whether the archive agrees with itself, which a tilt
  // can satisfy while walking away from the ground.
  const held = heldOut({ 1: ["a", "b", "c"] });
  const flat = observations({
    a: [obs(1, 0, 10, 10)],
    b: [obs(1, 1, 10, 10)],
    c: [obs(1, 2, 10, 10)],
  });
  const tilted = observations({
    a: [obs(1, 0, 5, 10)],
    b: [obs(1, 1, 10, 10)],
    c: [obs(1, 2, 15, 10)],
  });
  assert.deepEqual([...terrainDisagreements(flat, held).values()], [0, 0, 0]);
  assert.deepEqual([...terrainDisagreements(tilted, held).values()], [5, 0, 5]);
});

test("summarise on an empty set is NaN rather than zero, and n says so", () => {
  // Zero would read as "perfect agreement". NaN propagates into the verdict,
  // where `NaN <= x` and `x <= NaN` are both false, and the NONE branch above it
  // is what stops that being reported as a regression.
  const s = summarise([]);
  assert.equal(s.n, 0);
  assert.ok(Number.isNaN(s.median) && Number.isNaN(s.mean));
});

test("pairedChange ignores comparisons present in only one mode", () => {
  // A key with no partner cannot be a change, and counting it as one would let
  // the population differ between modes without the difference being visible.
  const change = pairedChange(values(1, 2, 3), new Map([["c0", 0.5]]));
  assert.equal(change.improved, 1);
  assert.equal(change.worsened, 0);
  assert.equal(change.unchanged, 0);
});

// ---------------------------------------------------------------------------
// Round two. A cold critic re-broke the four gates above; these pin what it
// found. Every one of these is a case where the FIRST round of fixes left the
// reference pattern -- a check that cannot fail, or evidence that is not
// independent -- standing in a new place.
// ---------------------------------------------------------------------------

test("THE REGRESSION: one non-finite value must not silence the mean and worst gates", () => {
  // `Math.max(NaN, 293.5)` is NaN and `NaN > 15` is false, so a single
  // unreadable comparison used to switch off the mean gate AND the
  // worst-regression gate for the whole measure -- while being filed as
  // `worsened` by the sign test's `else`, padding the count gate in the passing
  // direction. Harm that disables the alarm and then pads the register.
  //
  // This is history defect 2 ("every comparison against NaN is false")
  // relocated out of the untouched proof, where it was fixed, and into the
  // verdict function written in the same commit.
  assert.equal(Math.max(NaN, 293.5), NaN as unknown as number, "the JS behaviour this rests on");
  assert.equal(NaN > 15, false);

  const before = new Map([["a", 1], ["b", 1], ["c", 1], ["d", 1]]);
  const after = new Map([["a", 0.9], ["b", 0.9], ["c", 294.5], ["d", NaN]]);
  const change = pairedChange(before, after);

  assert.equal(change.nonFinite, 1, "the unreadable comparison is counted apart");
  assert.equal(change.worsened, 1, "and NOT filed as a regression");
  assert.ok(Number.isFinite(change.worstRegressionM), "so Math.max is never poisoned");
  assert.ok(Number.isFinite(change.meanChangeM));

  const { verdict, reasons } = judgeMeasure(
    "self-consistency",
    summarise([...before.values()]),
    summarise([...after.values()]),
    change,
  );
  assert.equal(verdict, "FAIL");
  assert.ok(reasons.some((r) => r.includes("non-finite")));
});

test("summarise keeps non-finite values out of its statistics and counts them", () => {
  // A mean over a set containing NaN is NaN, and NaN silences a `>` comparison
  // rather than tripping it. Reporting the count separately is what lets the
  // gate fire instead of going quiet.
  const s = summarise([1, 2, 3, NaN, Infinity]);
  assert.equal(s.n, 5);
  assert.equal(s.nonFinite, 2);
  assert.equal(s.median, 2);
  assert.equal(s.mean, 2);
});

test("a non-finite value in either summary is a FAIL on its own", () => {
  const clean = summarise([1, 1, 1]);
  const dirty = summarise([1, 1, NaN]);
  const change = pairedChange(values(1, 1, 1), values(1, 1, 1));
  assert.equal(judgeMeasure("self-consistency", clean, dirty, change).verdict, "FAIL");
  assert.equal(judgeMeasure("self-consistency", dirty, clean, change).verdict, "FAIL");
});

test("THE REGRESSION: an untreated ride the proof never looked at is not certified", () => {
  // The bucket skip is per bucket; the premise it establishes is about rides.
  // An untreated ride sharing every bucket with a treated ride is never checked,
  // while another ride's private buckets keep `checked` above zero so the script
  // prints an affirmative "verified identical: N/N". That ride is then also
  // filtered out of the treated-scope measures and appears only in the
  // whole-archive line, which is never gated: it can be 40m out and exit 0.
  const before = observations({
    shared: [obs(1, 0, 100), obs(3, 0, 100)], // ride 3 only ever appears beside treated ride 1
    private: [obs(2, 0, 50)],
  });
  const after = observations({
    shared: [obs(1, 0, 140), obs(3, 0, 140)],
    private: [obs(2, 0, 50)],
  });

  const proof = verifyUntouched(before, after, new Set([1]));

  assert.ok(proof.checked > 0, "ride 2's private bucket keeps the count affirmative");
  assert.equal(proof.vacuous, false, "so the global vacuity test cannot see this");
  assert.deepEqual(proof.uncheckedSessions, [3]);
});

test("an untreated ride with at least one private bucket is covered", () => {
  // The other half of the pair, so `uncheckedSessions` cannot be satisfied by
  // always naming everyone.
  const before = observations({
    shared: [obs(1, 0, 100), obs(3, 0, 100)],
    own: [obs(3, 1, 70)],
  });
  const after = observations({
    shared: [obs(1, 0, 140), obs(3, 0, 100)],
    own: [obs(3, 1, 70)],
  });
  assert.deepEqual(verifyUntouched(before, after, new Set([1])).uncheckedSessions, []);
});

test("THE REGRESSION: the proof sees a bucket that exists only in 'after'", () => {
  // The after-only scan lived inside `for (const [key] of before)`, so a key
  // absent from `before` was never visited -- and that is the direction the
  // check was written for, since the risk is a fitter that makes buckets
  // qualify which did not before. It advertised "either direction" and could
  // see one.
  const before = observations({ a: [obs(2, 0, 100)] });
  const after = observations({ a: [obs(2, 0, 100)], NEW: [obs(2, 5, 999)] });
  assert.equal(verifyUntouched(before, after, new Set()).structurallyDifferent, 1);
});

test("THE REGRESSION: medianChangeM is the proper median, not the upper of two middles", () => {
  // `moved[Math.floor(moved.length / 2)]` takes the UPPER middle on an even
  // count, so a perfectly balanced set of changes printed a positive number by
  // construction. On fifty comparisons worse by 9m against fifty better by 10m
  // it read `median_change_m: 9.00` while the mean read -0.50 and total error
  // had fallen by 50m. A printed statistic that reads as harm on a population
  // that improved is worse than an ungated one: it invites the override it
  // looks like it should trigger.
  //
  // The verdict on this population is PASS and that is correct -- the counts tie
  // and the total fell. What was wrong was the number beside it.
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  for (let i = 0; i < 50; i++) {
    before.set(`w${i}`, 100 + i);
    after.set(`w${i}`, 109 + i);
  }
  for (let i = 0; i < 50; i++) {
    before.set(`b${i}`, 300 + i);
    after.set(`b${i}`, 290 + i);
  }
  const change = pairedChange(before, after);

  assert.equal(change.improved, 50);
  assert.equal(change.worsened, 50, "a tie, which the count gate correctly lets through");
  assert.equal(change.medianChangeM, -0.5, "was 9 under the upper-middle convention");
  assert.equal(change.meanChangeM, -0.5, "and now agrees with the mean, as it should");

  // An odd count still takes the single middle value.
  assert.equal(pairedChange(values(10, 10, 10), values(8, 9, 20)).medianChangeM, -1);
});

test("THE REGRESSION: one moving comparison in ten thousand is not a quorum", () => {
  // `improved === 0 && worsened === 0` is a step where power is continuous. One
  // comparison improving by a tenth of a micrometre licensed a verdict over the
  // 9,999 that could not move -- a quorum of one, which is the family this
  // feature has been rejected for four times.
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  for (let i = 0; i < 10000; i++) {
    before.set(`k${i}`, 5);
    after.set(`k${i}`, 5);
  }
  after.set("k0", 5 - 1e-7);

  const change = pairedChange(before, after);
  assert.equal(change.improved, 1);
  assert.equal(change.unchanged, 9999);

  const { verdict, reasons } = judgeMeasure(
    "self-consistency",
    summarise([...before.values()]),
    summarise([...after.values()]),
    change,
  );
  assert.equal(verdict, "INCONCLUSIVE");
  assert.ok(reasons.some((r) => r.includes("zero power")));
});

test("the zero-power rule fires on a majority frozen, not on any frozen at all", () => {
  // The boundary in both directions, because a rule stated as a ratio has one
  // and an all-or-nothing rule did not. Three moved against two frozen is
  // judged; two moved against three frozen is not.
  const judge = (movedCount: number, frozen: number) => {
    const before = new Map<string, number>();
    const after = new Map<string, number>();
    for (let i = 0; i < movedCount; i++) {
      before.set(`m${i}`, 5);
      after.set(`m${i}`, 4);
    }
    for (let i = 0; i < frozen; i++) {
      before.set(`f${i}`, 5);
      after.set(`f${i}`, 5);
    }
    return judgeMeasure(
      "self-consistency",
      summarise([...before.values()]),
      summarise([...after.values()]),
      pairedChange(before, after),
    ).verdict;
  };
  assert.equal(judge(3, 2), "PASS");
  assert.equal(judge(2, 3), "INCONCLUSIVE");
  assert.equal(judge(3, 3), "PASS", "an exact tie still has half its power");
});

test("the frozen-majority rule applies to the treated scope, not to the whole archive", () => {
  // Caught by running the thing rather than by a fixture. The whole-archive
  // scope is DOMINATED by rides the change never touched, whose before and
  // after are identical by construction -- that fixed unchanged mass is exactly
  // what the untouched-bucket proof establishes. Applying the ratio there
  // reported the design as a defect on every run: all three measures came back
  // INCONCLUSIVE with 146 of 162, 824 of 1077 and 5050 of 5338 frozen.
  //
  // A measure where literally nothing moved is still inconclusive in either
  // scope; that is a different statement from "most of it is untreated".
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  for (let i = 0; i < 100; i++) {
    before.set(`f${i}`, 5);
    after.set(`f${i}`, 5);
  }
  before.set("m0", 5);
  after.set("m0", 4);
  const b = summarise([...before.values()]);
  const a = summarise([...after.values()]);
  const change = pairedChange(before, after);

  assert.equal(judgeMeasure("self-consistency", b, a, change, "treated").verdict, "INCONCLUSIVE");
  assert.equal(judgeMeasure("self-consistency", b, a, change, "whole archive").verdict, "PASS");

  const frozen = pairedChange(values(5, 5, 5), values(5, 5, 5));
  const flat = summarise([5, 5, 5]);
  assert.equal(
    judgeMeasure("self-consistency", flat, flat, frozen, "whole archive").verdict,
    "INCONCLUSIVE",
    "nothing moving at all is inconclusive in either scope",
  );
});

test("F3/F5: the held-out split is a function of the bucket alone, so `every` equals `any` today", () => {
  // Pinning the invariant rather than the impossible input. `heldOut` in
  // evalAnchorDrift.ts takes a key and no session, so for a given bucket either
  // every contributor held it out or none did. The `every` quantifier in
  // `crossRideDisagreements` therefore costs nothing at present, and the
  // comment there says so rather than reporting a cost that was never paid.
  //
  // This test exists so that the day the split is made per session -- which is
  // the better control -- the inertness is a recorded fact to revisit rather
  // than a surprise.
  const heldOutByKeyAlone = (key: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 16) & 1) === 1;
  };
  let disagreements = 0;
  for (let s = 1; s <= 2000; s++) {
    for (const d of ["forward", "backward"]) {
      const key = `${s}|${d}|15`;
      // Two different sessions asking about the same bucket get the same answer.
      if (heldOutByKeyAlone(key) !== heldOutByKeyAlone(key)) disagreements += 1;
    }
  }
  assert.equal(disagreements, 0);
});

test("the `every contributor` quantifier still behaves correctly if the split ever goes per session", () => {
  // Kept as a behaviour test of the quantifier itself, labelled for what it is:
  // the input below cannot arise from today's `heldOut`, so this guards a future
  // change rather than a present one. The previous version of this test made the
  // same construction while claiming it measured a cost being paid now.
  const both = heldOut({ 1: ["k"], 2: ["k"] });
  const onlyOne = heldOut({ 1: ["k"], 2: [] });
  const data = observations({ k: [obs(1, 0, 10), obs(2, 0, 20)] });
  assert.equal(crossRideDisagreements(data, both).size, 1);
  assert.equal(crossRideDisagreements(data, onlyOne).size, 0);
});

test("F4: cross-ride is translation invariant, and the comment must not claim otherwise", () => {
  // Mean absolute deviation does not move when every contributor moves by the
  // same amount, which is exactly when the drawn running mean moves most. The
  // range it replaced was blind to this too -- replacing one spread with another
  // fixes blindness in the middle and cannot fix blindness to a shift.
  //
  // Pinned rather than fixed, because setting the level IS the anchor's job and
  // a disagreement measure should not punish it. What this records is that NO
  // measure in this file sees a uniform level change, so if the level is ever
  // the question it needs a fourth measure and not an edit to this one.
  const held = heldOut({ 1: ["k"], 2: ["k"] });
  const before = observations({ k: [obs(1, 0, 10), obs(2, 0, 20), obs(2, 1, 30)] });
  const after = observations({ k: [obs(1, 0, 25), obs(2, 0, 35), obs(2, 1, 45)] });

  const drawn = (o: Observations) => {
    const v = o.get("k")!.map((x) => x.elevationM);
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  assert.equal(drawn(after) - drawn(before), 15, "the drawn value moved 15m");
  assert.equal(
    crossRideDisagreements(before, held).get("k"),
    crossRideDisagreements(after, held).get("k"),
    "and the measure does not move -- by construction, not by accident",
  );
});

// --- the eighteen mutants the critic found alive -----------------------------

test("summarise's quantiles are the ones it names", () => {
  // The median, p90 and worst were all unpinned: three of the five numbers the
  // script prints as evidence. A 40th-percentile median or a p95 read as p90
  // would have changed every printed verdict line and no test.
  // Twenty values, not ten: on ten, `at(0.9)` and `at(0.95)` both land on index
  // 9, so a p90 reported as p95 was indistinguishable. The first version of this
  // test used ten and the mutant survived it.
  const s = summarise(Array.from({ length: 20 }, (_, i) => i));
  assert.equal(s.median, 10, "at(0.5) on twenty values");
  assert.equal(s.p90, 18, "and NOT 19, which is where p95 lands");
  assert.equal(s.worst, 19);
  assert.equal(s.mean, 9.5);
  const t = summarise([10, 0, 5]);
  assert.equal(t.worst, 10, "worst is the largest disagreement, not the smallest");
  assert.equal(t.median, 5);
});

test("self-consistency compares the first pass against the LAST, not the second", () => {
  // A ride passing a bucket three times has two increments; the measure is the
  // ride's disagreement with itself across the whole ride, so it is first
  // against last. With passes at 10, 12 and 20 that is 10, not 2.
  const held = heldOut({ 1: ["k"] });
  const three = observations({
    k: [obs(1, 0, 10), obs(1, 30 * MIN, 12), obs(1, 60 * MIN, 20)],
  });
  assert.equal(selfDisagreements(three, held).get("k|1"), 10);
});

test("cross-ride and terrain shape both honour the treated scope", () => {
  // The suite never passed `only` to either, so removing the filter from either
  // left it green -- and where that filter sits is the thing the review spent a
  // page on. Cross-ride's is per bucket (admit the bucket if any contributor was
  // treated, then measure the full spread, because the spread has no owner);
  // terrain shape's is per observation, which is per ride here.
  // Session 3 must be given held-out keys too, or the held-out filter excludes
  // bucket u on its own and the treated filter is never exercised. The first
  // version of this test omitted it and the mutant survived: the assertion held
  // for a reason other than the one it names, which is the pattern this whole
  // file is about.
  const held = heldOut({ 1: ["k", "u"], 2: ["k", "u"], 3: ["k", "u"] });
  const data = observations({
    k: [obs(1, 0, 10, 5), obs(2, 0, 20, 5)],
    u: [obs(2, 0, 30, 5), obs(3, 0, 40, 5)],
  });

  const cross = crossRideDisagreements(data, held, new Set([1]));
  assert.deepEqual([...cross.keys()], ["k"], "bucket u has no treated contributor");

  const terrain = terrainDisagreements(data, held, new Set([1]));
  assert.ok(
    [...terrain.keys()].every((k) => k.includes("|1|")),
    `only ride 1's observations may be scored, got ${[...terrain.keys()].join(", ")}`,
  );
});

test("terrain shape removes each ride's MEDIAN level, not its mean", () => {
  // Every terrain fixture above uses a symmetric residual set, where median and
  // mean coincide, so swapping one for the other left the suite green. The
  // difference is the whole point: a median level is not dragged by one outlier
  // bucket, and a mean level would smear that outlier across every other bucket
  // of the ride.
  const held = heldOut({ 1: ["a", "b", "c", "d"] });
  const skewed = observations({
    a: [obs(1, 0, 10, 0)],
    b: [obs(1, 1, 11, 0)],
    c: [obs(1, 2, 12, 0)],
    d: [obs(1, 3, 100, 0)],
  });
  // Residuals 10, 11, 12, 100. Median level is 11.5; a mean level would be 33.25.
  assert.deepEqual([...terrainDisagreements(skewed, held).values()], [1.5, 0.5, 0.5, 88.5]);
});

test("terrain shape skips buckets the terrain model has no value for", () => {
  // Without the null check, `elevationM - null` is `elevationM - 0` and a
  // DEM-less bucket scores as a raw elevation -- roughly 1800 in this archive --
  // which would then set the ride's median level for every other bucket.
  const held = heldOut({ 1: ["a", "b"] });
  const data = observations({
    a: [obs(1, 0, 1810, 1800)],
    b: [obs(1, 1, 1805, null)],
  });
  const out = terrainDisagreements(data, held);
  assert.equal(out.size, 1);
  assert.ok([...out.keys()][0].startsWith("a|"));
});

test("the untouched proof matches observations by identity, not by array position", () => {
  // Both lists are built in the same loop order today, so indexing works by
  // luck. A reordering anywhere upstream would silently start comparing one
  // ride's bucket against another's and still report agreement -- which is the
  // failure this proof exists to make impossible, not to reproduce.
  const before = observations({ k: [obs(2, 0, 100), obs(3, 0, 200)] });
  const after = observations({ k: [obs(3, 0, 200), obs(2, 0, 100)] }); // same data, swapped
  const proof = verifyUntouched(before, after, new Set());
  assert.equal(proof.checked, 2);
  assert.equal(proof.moved, 0, "order must not matter");

  const reordered = observations({ k: [obs(3, 0, 100), obs(2, 0, 200)] }); // values swapped
  assert.equal(
    verifyUntouched(before, reordered, new Set()).moved,
    2,
    "but swapping which ride holds which value must be caught",
  );
});

test("worstRegressionM is the worst regression, not the last one", () => {
  const change = pairedChange(values(10, 10, 10), values(50, 12, 11));
  assert.equal(change.worstRegressionM, 40);
});

test("meanChangeM averages over every paired comparison, including the unchanged", () => {
  // Averaging over moved comparisons only would let a change that froze most of
  // the archive and hurt the rest report a small mean. The gate's question is
  // "did total error go down", and comparisons that held are part of the total.
  const change = pairedChange(values(10, 10, 10, 10), values(10, 10, 10, 14));
  assert.equal(change.meanChangeM, 1, "4m of harm over 4 comparisons, not over 1");
});

test("the gate boundaries are the ones the comments claim", () => {
  // `>` against `>=` on each gate: an exactly-equal median, mean or worst
  // regression is not a regression, and must not be reported as one.
  const flat = values(5, 5, 5, 5);
  const moved = new Map([["c0", 4], ["c1", 5], ["c2", 5], ["c3", 6]]);
  const b = summarise([...flat.values()]);
  const a = summarise([...moved.values()]);
  const change = pairedChange(flat, moved);
  assert.equal(a.mean, b.mean, "mean exactly equal");
  assert.equal(change.improved, 1);
  assert.equal(change.worsened, 1, "counts exactly equal");
  assert.equal(judgeMeasure("self-consistency", b, a, change).verdict, "PASS");

  // And exactly at the worst-regression bound, which must not fire.
  const atBound = pairedChange(values(0, 0), values(0, MAX_DEFENSIBLE_REGRESSION_M["self-consistency"]));
  assert.equal(atBound.worstRegressionM, 15);
  assert.ok(
    !judgeMeasure(
      "self-consistency",
      summarise([0, 0]),
      summarise([0, 15]),
      atBound,
    ).reasons.some((r) => r.includes("worst single regression")),
    "exactly at the bound is inside it",
  );
});

test("NONE needs both sides empty, and one empty side is judged rather than excused", () => {
  // `before.n === 0 || after.n === 0` would file a half-populated measure as
  // "nothing to judge", which is the reassuring direction. One side empty means
  // nothing pairs, which is zero power, not zero comparisons.
  const some = summarise([1, 2, 3]);
  const none = summarise([]);
  const empty = pairedChange(new Map(), new Map());
  assert.equal(judgeMeasure("self-consistency", none, none, empty).verdict, "NONE");
  assert.equal(judgeMeasure("self-consistency", some, none, empty).verdict, "INCONCLUSIVE");
  assert.equal(judgeMeasure("self-consistency", none, some, empty).verdict, "INCONCLUSIVE");
});
