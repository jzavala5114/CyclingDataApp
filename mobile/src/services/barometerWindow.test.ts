import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  decodeReadings,
  DEFAULT_HALF_WINDOW_MS,
  MAX_HALF_WINDOW_MS,
  MAX_PLAUSIBLE_HPA,
  MIN_PLAUSIBLE_HPA,
  SEA_LEVEL_HPA,
  altitudeAtFix,
  altitudeFromPressureHpa,
  isUsableReading,
  readingsInWindow,
  resolveHalfWindowMs,
  type PressureReading,
} from "./barometerWindow.js";

// A fixed wall clock so no test depends on when it ran. Real `atMs` values are
// epoch milliseconds around 1.8e12, and using a realistic magnitude is the
// point: a window implemented by summing raw timestamps and differencing after
// would only lose precision at this scale, never at 0.
const T = Date.UTC(2026, 9, 1, 14, 30, 0);

// Pressure near this city, ~1800m up. Not 1013.25. Tests that use sea-level
// pressure would sit on the one input where the formula returns exactly 0 and
// would miss a sign error in the exponent entirely.
const CITY_HPA = 840;

// 9.686m of height per hPa at 840, from the formula below. Tests express climbs
// in metres and convert, so the numbers in a test read like a bike ride.
const M_PER_HPA = altitudeFromPressureHpa(CITY_HPA) - altitudeFromPressureHpa(CITY_HPA + 1);

const r = (atMs: number, hPa: number): PressureReading => ({ atMs, hPa });

// Readings as the sensor would have produced them: one every `periodMs` from
// `fromMs` through `toMs` inclusive, pressure from a function of time. Lets a
// test describe a 60-second climb instead of listing 301 numbers.
function sweep(
  fromMs: number,
  toMs: number,
  periodMs: number,
  hPaAt: (atMs: number) => number,
): PressureReading[] {
  const out: PressureReading[] = [];
  for (let atMs = fromMs; atMs <= toMs; atMs += periodMs) out.push(r(atMs, hPaAt(atMs)));
  return out;
}

const offsets = (readings: readonly PressureReading[], fixAtMs: number) =>
  readings.map((x) => x.atMs - fixAtMs).sort((a, b) => a - b);

function approx(actual: number, expected: number, tolerance: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} vs expected ${expected} (off by ${Math.abs(actual - expected)}, tolerance ${tolerance})`,
  );
}

// --- Rubric 1: the no-regression path -------------------------------------

test("THE NO-REGRESSION PATH: nothing usable means null, which is how the caller reaches for GPS altitude", () => {
  // Four ways the sensor can fail a fix, all of which must arrive at the same
  // answer, because the caller has exactly one fallback branch to take.
  assert.equal(altitudeAtFix([], T), null, "no readings at all");
  assert.equal(altitudeAtFix([r(T - 3000, CITY_HPA)], T), null, "only a reading 3s away");
  assert.equal(altitudeAtFix([r(T, Number.NaN)], T), null, "only a NaN reading");
  assert.equal(
    altitudeAtFix(undefined as unknown as PressureReading[], T),
    null,
    "a native module that handed back nothing",
  );
});

test("THE NO-REGRESSION PATH: it never widens the window or reuses the nearest reading", () => {
  // The temptation is to hand back the closest reading when the window is
  // empty, because a height is better than no height. It is not: a reading 3
  // seconds away is up to 33m of road away, which is the error this module
  // exists to bound. Pinned here so nobody adds the "helpful" fallback later.
  const readings = [r(T - 4000, CITY_HPA), r(T + 4000, CITY_HPA)];
  assert.equal(altitudeAtFix(readings, T), null);
  // And the nearest-reading answer, had we taken it, would have looked fine,
  // which is exactly why this has to be pinned by behaviour and not by eye.
  assert.ok(Number.isFinite(altitudeFromPressureHpa(readings[0].hPa)));
});

// --- Rubric 2: a height belongs to a place --------------------------------

test("THE DEFAULT half-window is +/-500ms, and this is what pins it", () => {
  const readings = [
    r(T - 600, CITY_HPA),
    r(T - 500, CITY_HPA),
    r(T, CITY_HPA),
    r(T + 500, CITY_HPA),
    r(T + 600, CITY_HPA),
  ];
  assert.equal(DEFAULT_HALF_WINDOW_MS, 500);
  const result = altitudeAtFix(readings, T);
  assert.ok(result !== null);
  assert.equal(result.readingCount, 3, "the two readings 600ms out are not this fix's");
  assert.deepEqual(offsets(readingsInWindow(readings, T), T), [-500, 0, 500]);
  assert.equal(result.meanOffsetMs, 0);
});

test("BOUNDARY: the window edge is inclusive on both sides, and it bites", () => {
  // One millisecond decides whether a reading belongs to this fix. Which side
  // of the comparison the edge falls on changes the reading count by up to two
  // out of five or six, so it gets pinned rather than left to whoever edits
  // the comparison next.
  const edge = DEFAULT_HALF_WINDOW_MS;
  assert.equal(altitudeAtFix([r(T + edge, CITY_HPA)], T)?.readingCount, 1, "exactly +half is in");
  assert.equal(altitudeAtFix([r(T - edge, CITY_HPA)], T)?.readingCount, 1, "exactly -half is in");
  assert.equal(altitudeAtFix([r(T + edge + 1, CITY_HPA)], T), null, "one ms past +half is out");
  assert.equal(altitudeAtFix([r(T - edge - 1, CITY_HPA)], T), null, "one ms past -half is out");
});

test("A HEIGHT BELONGS TO A PLACE: sixty seconds of climbing cannot reach this fix", () => {
  // The whole reason the rule exists. 5 m/s on a 5% grade is 0.25m of climb
  // per second, so a 60-second window spans 300m of road and 15m of height,
  // and the mean of it sits ~7.5m from a fix at either end. The fix below is
  // at the top of the climb, so the unbounded mean reports the height of
  // ground the rider passed 30 seconds and 150m ago. That error is invisible
  // in the output: ~1561m where the truth is ~1569m is a perfectly plausible
  // height for this city, and nothing in the stored sample says which it is.
  const climbMPerS = 5 * 0.05;
  const hPaPerS = climbMPerS / M_PER_HPA;
  const hPaAt = (atMs: number) => CITY_HPA - (hPaPerS * (atMs - T)) / 1000;
  const readings = sweep(T, T + 60_000, 200, hPaAt);
  assert.equal(readings.length, 301, "60s at the requested 5Hz");

  const fixAtMs = T + 60_000;
  const truthM = altitudeFromPressureHpa(hPaAt(fixAtMs));
  const result = altitudeAtFix(readings, fixAtMs);
  assert.ok(result !== null);

  // Only the last three readings are this fix's: nothing has been sampled
  // after it yet, so the window is one-sided here and leans 200ms early.
  assert.equal(result.readingCount, 3);
  assert.equal(result.meanOffsetMs, -200);
  // 200ms of lean at 5 m/s is 1m of road, so 0.05m of height. Bounded, and
  // bounded by the window rather than by luck.
  approx(result.absoluteM, truthM, 0.06, "windowed height at the fix");

  // What the accumulator this replaces would have said, had a dropped fix or a
  // suspended task made its window 60s wide. Also pinned from the other side:
  // the windowed answer has to be at least 100x closer to the truth, or the
  // window is not doing the job it was added for.
  const meanOfEverything = readings.reduce((sum, x) => sum + x.hPa, 0) / readings.length;
  const unboundedM = altitudeFromPressureHpa(meanOfEverything);
  assert.ok(
    truthM - unboundedM > 7,
    `the unbounded mean should sit >7m below the fix, it sat ${(truthM - unboundedM).toFixed(2)}m`,
  );
  assert.ok(
    Math.abs(truthM - result.absoluteM) * 100 < Math.abs(truthM - unboundedM),
    "the windowed height must beat the unbounded one by two orders of magnitude",
  );
  // 15m of climb over the 300m the window spanned, which is the rubric's
  // number arrived at from this ride's own arithmetic rather than asserted.
  approx(
    altitudeFromPressureHpa(hPaAt(T + 60_000)) - altitudeFromPressureHpa(hPaAt(T)),
    15,
    0.02,
    "height spanned by a 60-second window",
  );
});

test("the half-window is capped at 2000ms, so no caller can ask for the fifteen-metre error", () => {
  assert.equal(MAX_HALF_WINDOW_MS, 2000);
  assert.equal(resolveHalfWindowMs({ halfWindowMs: 30_000 }), 2000);
  assert.equal(resolveHalfWindowMs({ halfWindowMs: 1500 }), 1500, "under the cap is honoured");
  const far = [r(T - 2500, CITY_HPA), r(T - 2000, CITY_HPA), r(T, CITY_HPA)];
  const result = altitudeAtFix(far, T, { halfWindowMs: 30_000 });
  assert.ok(result !== null);
  assert.equal(result.readingCount, 2, "the 2.5s-old reading stays out even at a 30s request");
});

test("at the one-second fix floor only a reading on the exact midpoint lands in two windows", () => {
  // Why the default is half of MIN_INTERVAL_MS: neighbouring fixes must not
  // average the same readings, or their noise correlates and the difference
  // the backend takes between them reads a real grade as flatter than it is.
  // Inclusive edges leave exactly one way to share a reading, and this is it.
  const fixA = T;
  const fixB = T + 1000;
  const aligned = [100, 300, 500, 700, 900].map((d) => r(T + d, CITY_HPA));
  const inA = new Set(readingsInWindow(aligned, fixA).map((x) => x.atMs));
  const inB = new Set(readingsInWindow(aligned, fixB).map((x) => x.atMs));
  const shared = [...inA].filter((atMs) => inB.has(atMs));
  assert.deepEqual(shared, [T + 500], "the midpoint reading, and nothing else");

  // Shift the sensor's phase by one reading and the overlap is gone, which is
  // what makes this a phase coincidence rather than a design flaw.
  const offGrid = [0, 200, 400, 600, 800, 1000].map((d) => r(T + d, CITY_HPA));
  const inA2 = new Set(readingsInWindow(offGrid, fixA).map((x) => x.atMs));
  const inB2 = new Set(readingsInWindow(offGrid, fixB).map((x) => x.atMs));
  assert.deepEqual([...inA2].filter((atMs) => inB2.has(atMs)), []);
});

// --- Rubric 5: average the pressure, then convert -------------------------

test("PIN: the conversion is the formula the accumulator already used, unchanged", () => {
  // A hard literal on purpose. Every other assertion in this file goes through
  // `altitudeFromPressureHpa`, so a mutated exponent or a flipped sign would
  // cancel out of both sides and leave the suite green. This is the one place
  // the formula itself is nailed down.
  assert.equal(SEA_LEVEL_HPA, 1013.25);
  assert.equal(altitudeFromPressureHpa(840), 1553.9559059816786);
  assert.equal(altitudeFromPressureHpa(SEA_LEVEL_HPA), 0, "the reference pressure is the datum");
  assert.ok(
    altitudeFromPressureHpa(839) > altitudeFromPressureHpa(840),
    "less pressure is more height",
  );
  // And the windowed result is that same formula, not a reimplementation.
  assert.equal(altitudeAtFix([r(T, 840)], T)?.absoluteM, 1553.9559059816786);
});

test("AVERAGE THE PRESSURE, THEN CONVERT: the other order reads high, and this says by how much", () => {
  // A deliberately wide spread, because the power law's curvature is what is
  // being measured and at a realistic +/-0.12 hPa the two orders differ by
  // 3.4e-5 m, which no assertion could tell from rounding. +/-20 hPa is not a
  // real window; it is the magnifying glass.
  const readings = [820, 830, 840, 850, 860].map((hPa, i) => r(T - 400 + i * 200, hPa));
  const result = altitudeAtFix(readings, T);
  assert.ok(result !== null);
  assert.equal(result.readingCount, 5);

  const averageThenConvert = altitudeFromPressureHpa(840);
  const convertThenAverage =
    readings.reduce((sum, x) => sum + altitudeFromPressureHpa(x.hPa), 0) / readings.length;

  assert.equal(result.absoluteM, averageThenConvert, "the mean is taken in pressure");
  approx(convertThenAverage - averageThenConvert, 0.9343, 0.001, "the curvature gap");
  assert.ok(
    Math.abs(result.absoluteM - convertThenAverage) > 0.5,
    "and the result is not the convert-then-average number",
  );
});

test("symmetric sensor noise cancels out of the mean exactly", () => {
  // What the averaging is for. Readings scattered evenly either side of the
  // truth must come back as the truth, with no residue from the conversion.
  const noise = [-0.12, 0.06, 0, -0.06, 0.12];
  const readings = noise.map((d, i) => r(T - 400 + i * 200, CITY_HPA + d));
  const result = altitudeAtFix(readings, T);
  assert.ok(result !== null);
  assert.equal(result.readingCount, 5);
  approx(result.absoluteM, altitudeFromPressureHpa(CITY_HPA), 1e-9, "noise averaged away");
});

// --- Rubric 4: each fix gets its own window -------------------------------

test("each fix in one delivered batch gets its own window, from one shared array", () => {
  // The bug this module is shaped around. expo-location hands the task several
  // locations at once; the accumulator was drained by the first and empty for
  // the rest, so a batch of four fixes carried one height between them.
  // Here the same array answers each fix separately.
  const hPaAt = (atMs: number) => CITY_HPA - (atMs - T) / 1000 / M_PER_HPA; // 1m of climb per second
  const readings = sweep(T, T + 8000, 200, hPaAt);
  const batch = [T + 1000, T + 3000, T + 5000, T + 7000];

  const heights = batch.map((fixAtMs) => {
    const out = altitudeAtFix(readings, fixAtMs);
    assert.ok(out !== null, `fix at +${fixAtMs - T}ms`);
    return out;
  });

  for (let i = 0; i < batch.length; i += 1) {
    approx(heights[i].absoluteM, altitudeFromPressureHpa(hPaAt(batch[i])), 0.01, `fix ${i}`);
    assert.equal(heights[i].readingCount, 5, `fix ${i} got its own five readings`);
    assert.equal(heights[i].meanOffsetMs, 0, `fix ${i} is centred on itself`);
  }
  // 2 seconds apart at 1m/s of climb: 2m apart, and strictly increasing.
  for (let i = 1; i < heights.length; i += 1) {
    approx(heights[i].absoluteM - heights[i - 1].absoluteM, 2, 0.02, `rise ${i}`);
  }
});

test("the readings array is never mutated, not even reordered", () => {
  // A frozen array makes this structural rather than a snapshot comparison: an
  // in-place sort or a splice throws in module scope, which is strict mode.
  const readings = [r(T + 300, 841), r(T - 300, 839), r(T, 840), r(T + 5000, 835)];
  const before = readings.map((x) => ({ ...x }));
  const frozen = Object.freeze(readings.map((x) => Object.freeze(x)));

  assert.doesNotThrow(() => altitudeAtFix(frozen, T));
  assert.doesNotThrow(() => readingsInWindow(frozen, T));
  assert.deepEqual([...frozen], before, "same readings, same order, same values");
  assert.notEqual(readingsInWindow(frozen, T), frozen, "a new array comes back, not the input");
});

test("nothing is carried between calls", () => {
  // No accumulator, no last-good-height, no cached window. Same question twice
  // gets the same answer, and a fix with no readings does not inherit the
  // previous fix's height.
  const readings = [r(T - 200, 840.1), r(T, 840), r(T + 200, 839.9)];
  const first = altitudeAtFix(readings, T);
  assert.equal(altitudeAtFix(readings, T + 9_999_999), null, "a far fix gets nothing");
  const again = altitudeAtFix(readings, T);
  assert.deepEqual(again, first);
  assert.deepEqual(altitudeAtFix(readings, T), first, "and again");
});

test("a fix outside the readings' whole span gets null, from either side", () => {
  const readings = sweep(T, T + 2000, 200, () => CITY_HPA);
  assert.equal(altitudeAtFix(readings, T - 60_000), null, "before the first reading");
  assert.equal(altitudeAtFix(readings, T + 60_000), null, "after the last reading");
  assert.ok(altitudeAtFix(readings, T + 1000) !== null, "CONTROL: inside the span still works");
});

// --- Rubric 3: survives garbage -------------------------------------------

test("out-of-order readings are selected by their timestamps, not their position", () => {
  // The native side is a ring buffer, so a drain that wrapped hands JS the
  // oldest entries after the newest. A binary search over that would pick the
  // wrong readings without throwing, which is the worst failure available here.
  const inOrder = [
    r(T - 400, 840.04),
    r(T - 200, 840.02),
    r(T, 840),
    r(T + 200, 839.98),
    r(T + 400, 839.96),
  ];
  const wrapped = [inOrder[3], inOrder[4], inOrder[0], inOrder[1], inOrder[2]];
  const reversed = [...inOrder].reverse();

  const expected = altitudeAtFix(inOrder, T);
  assert.ok(expected !== null);
  assert.equal(expected.readingCount, 5);
  assert.deepEqual(altitudeAtFix(wrapped, T), expected, "a wrapped ring reads the same");
  assert.deepEqual(altitudeAtFix(reversed, T), expected, "so does a fully reversed one");

  // And an old reading hiding among new ones is still excluded.
  const withStale = [inOrder[2], r(T - 45_000, 850), inOrder[3]];
  assert.equal(altitudeAtFix(withStale, T)?.readingCount, 2);
});

test("readings just after the fix are wanted, and a clock step into the far future is not", () => {
  // The fix timestamp is the GNSS fix time and it reaches the task 100-500ms
  // later, so part of the fix's own future is already on the sensor by the
  // time we are asked. Those readings are half of what makes the window
  // centred rather than trailing.
  const result = altitudeAtFix([r(T + 300, 840), r(T - 300, 840)], T);
  assert.equal(result?.readingCount, 2);
  assert.equal(result?.meanOffsetMs, 0);

  // A clock step or a nanosecond value in a millisecond field fails the same
  // comparison every other distant reading fails. No special case, and the
  // readings around it survive.
  const withJump = [r(T - 200, 840), r(T + 1e12, 839), r(T + 200, 840)];
  const survived = altitudeAtFix(withJump, T);
  assert.equal(survived?.readingCount, 2, "the two real readings, not the time traveller");
  assert.equal(survived?.absoluteM, altitudeFromPressureHpa(840));
});

test("GARBAGE: NaN and infinite pressure drop out and the rest of the window survives", () => {
  // One NaN in a mean is not one lost reading, it is every fix whose window
  // touches it, because NaN propagates through the sum. So the gate is per
  // reading.
  const readings = [
    r(T - 400, Number.NaN),
    r(T - 200, 840.5),
    r(T, Number.POSITIVE_INFINITY),
    r(T + 200, 839.5),
    r(T + 400, Number.NEGATIVE_INFINITY),
  ];
  const result = altitudeAtFix(readings, T);
  assert.ok(result !== null);
  assert.equal(result.readingCount, 2, "the two real readings");
  assert.equal(result.absoluteM, altitudeFromPressureHpa(840), "mean of 840.5 and 839.5");
  assert.ok(Number.isFinite(result.meanOffsetMs));
  assert.equal(result.meanOffsetMs, 0);
});

test("GARBAGE: a pressure no bicycle could be under is not a height, even though it converts", () => {
  // 0.001 hPa from a half-initialised sensor converts to 41,139.6m, which is
  // finite, so a `Number.isFinite` check alone lets it through. Clamping it to
  // the lower bound would make it 9,165m, still a number that looks like data.
  // Rejected instead, so the fix falls back to GPS altitude and says so.
  assert.ok(Number.isFinite(altitudeFromPressureHpa(0.001)), "the premise: it converts fine");
  assert.equal(altitudeAtFix([r(T, 0.001)], T), null);
  assert.equal(altitudeAtFix([r(T, 0)], T), null, "zero pressure");
  assert.equal(altitudeAtFix([r(T, -840)], T), null, "negative pressure");
  assert.equal(altitudeAtFix([r(T, 5000)], T), null, "five times sea level");

  // The bounds are physical: the highest rideable road on earth is ~480 hPa
  // and the lowest road under a record high is ~1084 hPa, so both are in.
  assert.equal(MIN_PLAUSIBLE_HPA, 300);
  assert.equal(MAX_PLAUSIBLE_HPA, 1100);
  assert.ok(isUsableReading(r(T, 480)), "Umling La, ~5,800m");
  assert.ok(isUsableReading(r(T, 1084)), "the record sea-level high");
  assert.ok(isUsableReading(r(T, MIN_PLAUSIBLE_HPA)), "BOUNDARY: the low bound is inclusive");
  assert.ok(isUsableReading(r(T, MAX_PLAUSIBLE_HPA)), "BOUNDARY: the high bound is inclusive");
  assert.equal(isUsableReading(r(T, MIN_PLAUSIBLE_HPA - 0.001)), false);
  assert.equal(isUsableReading(r(T, MAX_PLAUSIBLE_HPA + 0.001)), false);

  // And one bad reading does not take the good ones with it.
  assert.equal(altitudeAtFix([r(T - 200, 0.001), r(T + 200, CITY_HPA)], T)?.readingCount, 1);
});

test("GARBAGE: a NaN fix time has no window", () => {
  // There is no place to attribute a height to, so there is no height. Note
  // that IEEE-754 would have produced this answer anyway (every comparison
  // against NaN is false), which is why the guard is explicit in the source:
  // the behaviour must survive a rewrite of the selection loop.
  const readings = sweep(T - 1000, T + 1000, 200, () => CITY_HPA);
  assert.equal(altitudeAtFix(readings, Number.NaN), null);
  assert.equal(altitudeAtFix(readings, Number.POSITIVE_INFINITY), null);
  assert.equal(altitudeAtFix(readings, Number.NEGATIVE_INFINITY), null);
  assert.deepEqual(readingsInWindow(readings, Number.NaN), []);
  assert.ok(altitudeAtFix(readings, T) !== null, "CONTROL: a real fix time still works");
});

test("GARBAGE: a reading with no usable timestamp drops out", () => {
  // A reading whose `atMs` is missing cannot be placed, and a reading that
  // cannot be placed cannot be averaged -- the window is the only thing
  // deciding what belongs to this fix.
  const readings = [
    r(Number.NaN, CITY_HPA),
    r(Number.POSITIVE_INFINITY, CITY_HPA),
    { hPa: CITY_HPA } as unknown as PressureReading,
    r(T, CITY_HPA),
  ];
  assert.equal(altitudeAtFix(readings, T)?.readingCount, 1);
  assert.equal(isUsableReading(null), false);
  assert.equal(isUsableReading(undefined), false);
  assert.equal(isUsableReading({} as unknown as PressureReading), false);
  // The timestamp gate is pinned on the helper and not only through
  // `altitudeAtFix`, because the window comparison masks it: `Math.abs(NaN -
  // fix) <= half` is already false, so removing the gate changes nothing a
  // caller of `altitudeAtFix` can see. `isUsableReading` is exported and its
  // answer has to mean what it says.
  assert.equal(isUsableReading(r(Number.NaN, CITY_HPA)), false, "a NaN timestamp");
  assert.equal(isUsableReading(r(Number.POSITIVE_INFINITY, CITY_HPA)), false, "an infinite one");
  assert.ok(isUsableReading(r(T, CITY_HPA)), "CONTROL: a real reading is usable");
  // The global `isFinite` coerces, so a stringified reading off a bridge would
  // pass it. `Number.isFinite` does not, and this is what pins that choice.
  assert.equal(isUsableReading({ atMs: T, hPa: "840" } as unknown as PressureReading), false);
});

test("CONTROL: zero and negative halfWindowMs fall back to the default, not to a dead barometer", () => {
  // A window that can match nothing is not a narrower window, it is "no
  // barometer for this ride", and that failure is silent in the output. There
  // is no way to tell a caller who meant it from a config path where a missing
  // number arrived as 0, so the default wins.
  const readings = [r(T - 400, 840.5), r(T, 840), r(T + 400, 839.5)];
  const expected = altitudeAtFix(readings, T);
  assert.ok(expected !== null);
  assert.equal(expected.readingCount, 3);

  for (const halfWindowMs of [0, -1, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveHalfWindowMs({ halfWindowMs }), DEFAULT_HALF_WINDOW_MS, `${halfWindowMs}`);
    assert.deepEqual(altitudeAtFix(readings, T, { halfWindowMs }), expected, `${halfWindowMs}`);
  }
  assert.equal(resolveHalfWindowMs(undefined), DEFAULT_HALF_WINDOW_MS, "no options at all");
  assert.equal(resolveHalfWindowMs({}), DEFAULT_HALF_WINDOW_MS, "options with no half-window");
  // An explicit narrower window that CAN match is honoured, so this is a guard
  // against the impossible, not a refusal to be configured.
  assert.equal(resolveHalfWindowMs({ halfWindowMs: 200 }), 200);
  assert.equal(altitudeAtFix(readings, T, { halfWindowMs: 200 })?.readingCount, 1);
});

test("duplicate timestamps are two readings, not one", () => {
  // The OS batches sensor events and can stamp several with the same coarse
  // clock value. Both are real samples of the air, and averaging both is what
  // cancels their noise. Deduplicating would throw away a real reading, and
  // there is nothing in the data that distinguishes two samples one coarse
  // tick apart from one sample delivered twice.
  const readings = [r(T, 840.4), r(T, 839.6), r(T, 840.4), r(T, 839.6)];
  const result = altitudeAtFix(readings, T);
  assert.ok(result !== null);
  assert.equal(result.readingCount, 4);
  assert.equal(result.absoluteM, altitudeFromPressureHpa(840));
  assert.equal(result.meanOffsetMs, 0);
});

test("a single reading is a window of one, and readingCount says so", () => {
  // Not an error state. One reading is a worse height than six, and the only
  // honest thing to do is hand it over with the count attached so the caller
  // and the archive can see how thin it was.
  const result = altitudeAtFix([r(T + 120, CITY_HPA)], T);
  assert.ok(result !== null);
  assert.equal(result.readingCount, 1);
  assert.equal(result.absoluteM, altitudeFromPressureHpa(CITY_HPA));
  assert.equal(result.meanOffsetMs, 120);
});

test("a sensor slower than the 200ms it was asked for still yields a height", () => {
  // 200ms is a request, not a guarantee: Android coalesces sensor batches and
  // throttles them under Doze. At 1Hz a +/-500ms window holds one or two
  // readings instead of five or six, and one reading is still better than GPS
  // altitude. The count going down is the signal, not a reason to bail.
  const slow = sweep(T - 5000, T + 5000, 1000, () => CITY_HPA);
  const result = altitudeAtFix(slow, T);
  assert.ok(result !== null);
  assert.equal(result.readingCount, 1, "a 1Hz sensor lands once in a 1s window");

  // Slower still, and nothing lands. That is the null path, not a crash.
  const crawling = [r(T - 7000, CITY_HPA), r(T + 7000, CITY_HPA)];
  assert.equal(altitudeAtFix(crawling, T), null);
});

test("meanOffsetMs reports which way the window leaned, with the sign the contract promises", () => {
  // The reported lean is the whole defence for not correcting it: in practice
  // the fix timestamp arrives 100-500ms late, readings fill the earlier side
  // more completely, and the bias is near-constant across fixes so it cancels
  // out of a slope. None of that is checkable unless the lean is in the output.
  const early = altitudeAtFix([r(T - 400, 840), r(T - 200, 840)], T);
  assert.equal(early?.meanOffsetMs, -300, "negative when the window leans earlier than the fix");

  const late = altitudeAtFix([r(T + 200, 840), r(T + 400, 840)], T);
  assert.equal(late?.meanOffsetMs, 300, "positive when it leans later");

  const centred = altitudeAtFix([r(T - 400, 840), r(T + 400, 840)], T);
  assert.equal(centred?.meanOffsetMs, 0);

  // The realistic case: 300ms of delivery lag against a +/-500ms window.
  const lagged = sweep(T - 500, T + 300, 200, () => CITY_HPA);
  const result = altitudeAtFix(lagged, T);
  assert.ok(result !== null);
  assert.equal(result.readingCount, 5);
  assert.equal(result.meanOffsetMs, -100, "lopsided, by the amount the archive can now measure");
});

test("GARBAGE SWEEP: no shape of input throws, and every answer is null or a usable height", () => {
  // The cross product, because the failures that reach a background task come
  // in combinations nobody wrote a test for. Every cell must be either null or
  // a fully finite result with at least one reading behind it. A result that is
  // neither is the "plausible-looking wrong height" this is guarding against.
  const readingSets: unknown[] = [
    undefined,
    null,
    [],
    [null],
    [undefined],
    [{}],
    [{ atMs: "x", hPa: "y" }],
    [{ atMs: Number.NaN, hPa: CITY_HPA }],
    [{ atMs: T, hPa: Number.NaN }],
    [{ atMs: T, hPa: Number.POSITIVE_INFINITY }],
    [{ atMs: T, hPa: Number.NEGATIVE_INFINITY }],
    [{ atMs: T, hPa: 0 }],
    [{ atMs: T, hPa: -1 }],
    [{ atMs: Number.POSITIVE_INFINITY, hPa: CITY_HPA }],
    [{ atMs: T, hPa: CITY_HPA }],
    [{ atMs: T + 1e12, hPa: CITY_HPA }, { atMs: T - 1e12, hPa: CITY_HPA }],
    [{ atMs: T, hPa: CITY_HPA }, null, { atMs: T + 200, hPa: Number.NaN }],
    "not an array even slightly",
    42,
  ];
  const fixTimes = [T, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const optionSets: unknown[] = [
    undefined,
    null,
    {},
    { halfWindowMs: 0 },
    { halfWindowMs: -5 },
    { halfWindowMs: Number.NaN },
    { halfWindowMs: Number.POSITIVE_INFINITY },
    { halfWindowMs: 1e9 },
    { halfWindowMs: "500" },
  ];

  let checked = 0;
  for (const readings of readingSets) {
    for (const fixAtMs of fixTimes) {
      for (const options of optionSets) {
        const call = () =>
          altitudeAtFix(
            readings as PressureReading[],
            fixAtMs,
            options as { halfWindowMs?: number } | undefined,
          );
        assert.doesNotThrow(call, `${JSON.stringify(readings)} @ ${fixAtMs}`);
        const result = call();
        if (result === null) {
          checked += 1;
          continue;
        }
        const where = `${JSON.stringify(readings)} @ ${fixAtMs} ${JSON.stringify(options)}`;
        assert.ok(Number.isFinite(result.absoluteM), `absoluteM finite: ${where}`);
        assert.ok(Number.isFinite(result.meanOffsetMs), `meanOffsetMs finite: ${where}`);
        assert.ok(result.readingCount >= 1, `readingCount >= 1: ${where}`);
        assert.equal(Number.isInteger(result.readingCount), true, `readingCount integer: ${where}`);
        // Every height that comes back must be somewhere a bicycle could be,
        // which is the point of rejecting readings rather than clamping them.
        assert.ok(
          result.absoluteM > altitudeFromPressureHpa(MAX_PLAUSIBLE_HPA) - 1e-9 &&
            result.absoluteM < altitudeFromPressureHpa(MIN_PLAUSIBLE_HPA) + 1e-9,
          `height is physically reachable: ${result.absoluteM} from ${where}`,
        );
        checked += 1;
      }
    }
  }
  assert.equal(checked, readingSets.length * fixTimes.length * optionSets.length);
  assert.equal(checked, 1026, "the sweep actually ran the whole cross product");
});

// --- decodeReadings --------------------------------------------------------
//
// The bridge shape. These pin the one place where a native payload becomes
// something the window can read, because the failure mode on this path is
// silent: a decoder that produces nothing looks exactly like a sensor that
// stopped, and the ride records GPS altitude with nobody any the wiser.

test("a flat pair array becomes readings, oldest first, in the order given", () => {
  const readings = decodeReadings([1_700_000_000_000, 840.12, 1_700_000_000_200, 840.13]);
  assert.deepEqual(readings, [
    { atMs: 1_700_000_000_000, hPa: 840.12 },
    { atMs: 1_700_000_000_200, hPa: 840.13 },
  ]);
});

test("an ODD length drops the orphan rather than pairing it with undefined", () => {
  // A truncated payload. Pairing the last value with `undefined` would make a
  // NaN pressure, which `isUsableReading` would then drop anyway -- but only
  // after it had been counted, and only if that guard stays. Dropping it here
  // means the shape is right before anything reads it.
  const readings = decodeReadings([1_700_000_000_000, 840.12, 1_700_000_000_200]);
  assert.equal(readings.length, 1);
  assert.deepEqual(readings[0], { atMs: 1_700_000_000_000, hPa: 840.12 });
});

test("null, undefined and a non-indexable value decode to nothing instead of throwing", () => {
  assert.deepEqual(decodeReadings(null), []);
  assert.deepEqual(decodeReadings(undefined), []);
  assert.deepEqual(decodeReadings({} as unknown as ArrayLike<number>), []);
  assert.deepEqual(decodeReadings({ length: NaN } as unknown as ArrayLike<number>), []);
  assert.deepEqual(decodeReadings([]), []);
});

test("a typed array decodes the same as a plain one, because the bridge returns either", () => {
  // Expo's converter passes a Kotlin DoubleArray straight through on one path
  // and rebuilds it as a plain array on the other, so both shapes reach here.
  const flat = [1_700_000_000_000, 840.12, 1_700_000_000_200, 840.13];
  assert.deepEqual(decodeReadings(Float64Array.from(flat)), decodeReadings(flat));
});

test("decodeReadings does NOT filter, because isUsableReading is the only judge", () => {
  // A garbage reading survives decoding and is rejected by the window. Two
  // filters would drift: a reading the decoder dropped and the window would
  // have kept is a reading nobody can account for.
  const readings = decodeReadings([1_700_000_000_000, NaN, 1_700_000_000_200, 840.13]);
  assert.equal(readings.length, 2, "both pairs decode");
  assert.equal(isUsableReading(readings[0]!), false);
  assert.equal(isUsableReading(readings[1]!), true);
  const height = altitudeAtFix(readings, 1_700_000_000_200);
  assert.equal(height?.readingCount, 1, "and only the usable one reaches the mean");
});

test("END TO END: a native payload becomes one height for each fix in a batch", () => {
  // The whole path, in the order the background task runs it: the bridge hands
  // back a flat span covering several fixes, and each fix windows its own slice
  // of it. Before this change the first fix in a batch drained the accumulator
  // and the rest reused its value, so this is the behaviour that was broken.
  const base = 1_700_000_000_000;
  const flat: number[] = [];
  for (let i = 0; i < 50; i++) flat.push(base + i * 200, 840 - i * 0.01);
  const readings = decodeReadings(flat);

  const first = altitudeAtFix(readings, base + 1000);
  const second = altitudeAtFix(readings, base + 5000);
  assert.ok(first != null && second != null);
  assert.ok(first.readingCount >= 5, `first fix saw ${first.readingCount} readings`);
  assert.ok(second.readingCount >= 5, `second fix saw ${second.readingCount} readings`);
  assert.notEqual(
    first.absoluteM,
    second.absoluteM,
    "two fixes four seconds apart must not share one height",
  );
  // Pressure falls across the span, so the later fix is higher.
  assert.ok(second.absoluteM > first.absoluteM);
});

test("a fix past the end of the payload gets null, not the last reading it can find", () => {
  const base = 1_700_000_000_000;
  const readings = decodeReadings([base, 840.12, base + 200, 840.13]);
  assert.equal(altitudeAtFix(readings, base + 60_000), null);
});
