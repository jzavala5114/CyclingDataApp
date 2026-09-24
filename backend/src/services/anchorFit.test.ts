import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fitAnchor, MAX_PLAUSIBLE_OFFSET_M, MIN_POINTS_FOR_ANCHOR } from "./anchorFit.js";

// Gate tests for the single-number anchor, after the sliding ramp was removed.
//
// **The reference is `main`, not a rubric.** This file used to hold 45 tests, 41
// of them for a ramp that was rejected by four reviews and never shipped. What
// replaces them is one question asked properly: does the surviving function
// reproduce the behaviour that has been running in production all along?
//
// `mainFitDemOffset` below is an independent transcription of `fitDemOffset` as
// it stands on `main` at 9727a28, copied from the committed source rather than
// written from memory of it. The property test compares the two over random
// inputs. That is the same control reviewer B verified for the eval's
// `previousAnchor` -- 20,000 random sets, and it diverged correctly when either
// constant was moved -- reused here because the claim is the same claim: this
// change must not alter a single stored elevation.

// Transcribed from main: services/sessionProcessor.ts, `median` and
// `fitDemOffset`, with MIN_DEM_POINTS_FOR_ANCHOR = 10 and
// MAX_PLAUSIBLE_ANCHOR_OFFSET_M = 60 as its own literals.
//
// **Its own literals, NOT imports.** Importing the constants under test would
// make the control track the treatment: move one and both sides move together
// while the comparison keeps printing agreement. The boundary tests below pin
// the exported values separately, so a divergence fails loudly either way.
const MAIN_MIN_DEM_POINTS_FOR_ANCHOR = 10;
const MAIN_MAX_PLAUSIBLE_ANCHOR_OFFSET_M = 60;

function mainMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mainFitDemOffset(residuals: number[]): number | null {
  if (residuals.length < MAIN_MIN_DEM_POINTS_FOR_ANCHOR) return null;
  const offset = mainMedian(residuals);
  if (Math.abs(offset) > MAIN_MAX_PLAUSIBLE_ANCHOR_OFFSET_M) return null;
  return offset;
}

// A deterministic generator, so a failure is reproducible from the seed printed
// in the assertion rather than being a coin flip that vanishes on re-run.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test("THE REFERENCE: the anchor agrees with main's fitDemOffset on every finite input", () => {
  // 20,000 random residual sets straddling both constants: counts from 0 to 30
  // so MIN_POINTS_FOR_ANCHOR is crossed in both directions, and levels out to
  // +/-90m so MAX_PLAUSIBLE_OFFSET_M is too. If this passes, merging cannot
  // move a stored elevation, which is the whole safety claim of the removal.
  const random = lcg(20260923);
  let agreed = 0;
  for (let i = 0; i < 20000; i++) {
    const count = Math.floor(random() * 31);
    const centre = (random() - 0.5) * 180;
    const spread = random() * 20;
    const residuals = Array.from(
      { length: count },
      () => centre + (random() - 0.5) * spread,
    );
    const mine = fitAnchor(residuals);
    const theirs = mainFitDemOffset(residuals);
    assert.deepEqual(
      mine,
      theirs,
      `case ${i}: n=${count} centre=${centre.toFixed(3)} -> mine=${mine} main=${theirs}`,
    );
    agreed += 1;
  }
  assert.equal(agreed, 20000);
});

test("the property test can actually fail, or it proves nothing", () => {
  // A control on the control. If `mainFitDemOffset` were accidentally written to
  // call the code under test, the test above would pass no matter what broke.
  // Moving either constant must make the two disagree.
  const tightened = (residuals: number[]): number | null => {
    if (residuals.length < 14) return null; // MIN 10 -> 14
    const offset = mainMedian(residuals);
    if (Math.abs(offset) > MAIN_MAX_PLAUSIBLE_ANCHOR_OFFSET_M) return null;
    return offset;
  };
  const eleven = Array.from({ length: 11 }, (_, i) => i * 0.1);
  assert.notEqual(fitAnchor(eleven), tightened(eleven), "n=11 must straddle 10 and 14");

  const narrowed = (residuals: number[]): number | null => {
    if (residuals.length < MAIN_MIN_DEM_POINTS_FOR_ANCHOR) return null;
    const offset = mainMedian(residuals);
    if (Math.abs(offset) > 40) return null; // MAX 60 -> 40
    return offset;
  };
  const high = Array.from({ length: 12 }, () => 50);
  assert.notEqual(fitAnchor(high), narrowed(high), "50m must straddle 40 and 60");
});

test("the level is the median, not the mean", () => {
  // A handful of buckets sit on ground the OSM centreline does not follow, and
  // their residuals are large and one-sided. A mean lets those drag the whole
  // ride's level; a median does not. Ten at 2.0 and two far outliers: the median
  // is 2, the mean would be 8.
  const residuals = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 40, 32];
  assert.equal(fitAnchor(residuals), 2);
  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  assert.equal(Number(mean.toFixed(4)), 7.6667, "which is what a mean would have returned");
});

test("an even count averages the two middle readings", () => {
  assert.equal(fitAnchor([1, 1, 1, 1, 1, 3, 3, 3, 3, 3]), 2);
});

test("an odd count takes the single middle reading", () => {
  assert.equal(fitAnchor([1, 1, 1, 1, 1, 7, 9, 9, 9, 9, 9]), 7);
});

test("BOUNDARY: MIN_POINTS_FOR_ANCHOR is 10 points, and it bites", () => {
  // Below this the level is being fit to noise and the ride merges unanchored,
  // which is what the model did before anchoring existed. Pinned with literals
  // rather than with fixtures built from the constant, so moving the constant
  // fails the test instead of moving the test with it.
  assert.equal(MIN_POINTS_FOR_ANCHOR, 10);
  assert.equal(fitAnchor(Array.from({ length: 9 }, () => 5)), null);
  assert.equal(fitAnchor(Array.from({ length: 10 }, () => 5)), 5);
});

test("BOUNDARY: MAX_PLAUSIBLE_OFFSET_M is 60m, and it bites in both directions", () => {
  // Colorado's geoid separation is about -16m, and that ellipsoid-to-orthometric
  // gap is the whole reason a non-zero offset is normal. The bound has to clear
  // it comfortably without admitting nonsense. Exactly 60 is inside.
  assert.equal(MAX_PLAUSIBLE_OFFSET_M, 60);
  const at = (level: number) => fitAnchor(Array.from({ length: 12 }, () => level));
  assert.equal(at(60), 60, "exactly at the bound is inside it");
  assert.equal(at(-60), -60);
  assert.equal(at(60.01), null);
  assert.equal(at(-60.01), null);
});

test("a negative offset is returned as-is, because the geoid gap is negative", () => {
  // The caller SUBTRACTS this, so the sign matters and an abs() anywhere in the
  // chain would push every ride the wrong way by twice the geoid separation.
  assert.equal(fitAnchor(Array.from({ length: 12 }, () => -14.57)), -14.57);
});

test("an empty ride is unanchored rather than zero", () => {
  // Zero would read as "measured, and it needs no correction". Null is "not
  // measured", and the caller merges the ride untouched.
  assert.equal(fitAnchor([]), null);
});

test("DIVERGENCE FROM MAIN, deliberate: a non-finite residual does not become the offset", () => {
  // The one place this does NOT reproduce main, stated rather than hidden.
  //
  // Main filters nothing, and `[...].sort((a, b) => a - b)` with a NaN present
  // is not a sort: every comparison involving it answers NaN, which the engine
  // reads as "leave these alone", so the array comes back partly unsorted and
  // the "median" is whatever happened to land in the middle. Two consequences,
  // both verified by running main's transcription below rather than reasoned:
  //
  //   1. For some positions it returns **NaN as the offset**. `Math.abs(NaN) > 60`
  //      is false, so the plausibility guard waves it through, and the caller
  //      subtracts it from every bucket -- turning a whole ride into NaN heights.
  //   2. For others it returns a real number that **depends on the input order**.
  //      The same readings shuffled give a different anchor.
  //
  // This has never fired, because the caller builds residuals from DEM lookups
  // it has already null-checked. But `elevation_m` is `double precision` on both
  // sides of that subtraction and Postgres admits NaN there, so "cannot happen"
  // rests on the database rather than on the code.

  // 1. NaN in the middle poisons the answer outright.
  const poisoned = [1, 1, 1, 1, 1, NaN, 1, 1, 1, 1, 1];
  assert.ok(Number.isNaN(mainFitDemOffset(poisoned) as number), "main returns NaN as an offset");
  assert.equal(fitAnchor(poisoned), 1, "and this returns the median of what is real");

  // 2. Same multiset, two orders, two different answers from main.
  const ascending = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, NaN];
  const naNFirst = [NaN, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  assert.equal(mainFitDemOffset(ascending), 5);
  assert.equal(mainFitDemOffset(naNFirst), 4, "main's anchor depends on array order");
  assert.equal(fitAnchor(ascending), 4.5);
  assert.equal(fitAnchor(naNFirst), 4.5, "this one does not");

  // And when dropping them takes the ride below the minimum, it is unanchored
  // rather than anchored on a short sample.
  assert.equal(fitAnchor([1, 1, 1, 1, 1, NaN, NaN, NaN, NaN, NaN, NaN]), null);
  assert.equal(fitAnchor([Infinity, -Infinity, ...Array.from({ length: 10 }, () => 3)]), 3);
});
