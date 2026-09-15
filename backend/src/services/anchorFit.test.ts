import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  fitAnchor,
  fitDriftRate,
  largestCoveredBlock,
  MAX_PLAUSIBLE_OFFSET_M,
  MIN_POINTS_FOR_ANCHOR,
  type AnchorPoint,
  type Revisit,
} from "./anchorFit.js";

const MINUTE = 60_000;

// A ride's worth of terrain comparisons. `residualAt` is what the ride reads
// minus what the terrain model says, as a function of how far into the ride we
// are, so a test can describe a ride by its error rather than by a list.
function ride(
  minutes: number,
  perMinute: number,
  residualAt: (minute: number) => number,
): AnchorPoint[] {
  const points: AnchorPoint[] = [];
  for (let m = 0; m < minutes; m++) {
    for (let i = 0; i < perMinute; i++) {
      points.push({ atMs: m * MINUTE, residualM: residualAt(m) });
    }
  }
  return points;
}

// Places the ride crossed twice, all reporting the same rate of drift.
//
// The starts are staggered rather than stacked, so the pairs together span
// `fromMin`..`toMin`. That matters because the correction is a straight line
// only between the first and last moment a revisit actually observed, and is
// held flat outside it. A test that wants the whole ride corrected has to hand
// it revisits covering the whole ride.
//
// Two details that are not fussiness. The gap is added in whole milliseconds
// rather than computed from two fractional minutes, because staggering the
// starts gives fractions: a 30-minute gap came out as 1799999.9999999995ms and
// was dropped by a floor of exactly 1800s, so a helper asking for four pairs
// quietly handed over three. And the default gap sits above that floor rather
// than on it, so no test here depends on which way the boundary is decided --
// the tests that mean to probe it say so and carry their own timestamps.
// `site` defaults to a different segment per pair, because the ordinary case
// this helper stands for is a ride crossing several streets twice. Pass a fixed
// number to put every pair on one street, which is what MIN_REVISIT_SITES
// refuses -- only the test for that rule does.
function revisitsAt(
  rateMPerH: number,
  { count = 4, gapMin = 35, fromMin = 0, toMin = 59, site = null as number | null } = {},
): Revisit[] {
  const lastStart = toMin - gapMin;
  return Array.from({ length: count }, (_, i) => {
    const startMin = count === 1 ? fromMin : fromMin + ((lastStart - fromMin) * i) / (count - 1);
    const earlyAtMs = Math.round(startMin * MINUTE);
    return {
      earlyAtMs,
      lateAtMs: earlyAtMs + gapMin * MINUTE,
      riseM: (rateMPerH * gapMin) / 60,
      buckets: 3,
      segmentId: site ?? i + 1,
    };
  });
}

// What is left over after the correction is applied. On a ride whose true
// heights are flat this should be flat too: that is the whole job.
function spreadAfterCorrection(points: AnchorPoint[], fit: { offsetAt: (ms: number) => number }): number {
  const left = points.map((p) => p.residualM - fit.offsetAt(p.atMs));
  return Math.max(...left) - Math.min(...left);
}

test("the regression: a ride that slides during the hour is put back on one level", () => {
  // Flat ground, and the barometer wanders 8m over the hour. This is session 54
  // in miniature: it came back to a segment 51 minutes later and read 7.36m
  // lower, which a single number cannot remove. The ride noticed the slide
  // itself, by crossing its own path, which is what the revisits carry.
  const points = ride(60, 6, (m) => 20 + (8 * m) / 59);
  const revisits = revisitsAt(8 * (60 / 59));

  const ramp = fitAnchor(points, revisits);
  assert.ok(ramp, "a ride with points and revisits should fit");
  assert.equal(ramp.shape, "ramp");
  assert.ok(
    spreadAfterCorrection(points, ramp) < 0.5,
    `ramp should flatten the ride, left ${spreadAfterCorrection(points, ramp).toFixed(2)}m`,
  );

  // And the old behaviour does not. This half fails if the ramp is ever
  // removed: without it the residue is the whole 8m of drift, which is what
  // lands as a step between neighbouring buckets.
  const flat = fitAnchor(points, revisits, { allowRamp: false });
  assert.ok(flat);
  assert.equal(flat.shape, "constant");
  assert.ok(
    spreadAfterCorrection(points, flat) > 7.5,
    `single number should leave the drift behind, left ${spreadAfterCorrection(points, flat).toFixed(2)}m`,
  );
});

test("SAFETY: the terrain model cannot tilt the ride", () => {
  // The failure the eval caught, and the reason the slope is not fitted to
  // terrain. Here the residuals rise steadily -- exactly what a ride looks like
  // when it starts in one part of town where the terrain model reads low and
  // ends in another where it reads high. With no revisits saying the barometer
  // moved, nothing may tilt: that apparent slope belongs to the map, not the
  // instrument.
  const fit = fitAnchor(ride(60, 6, (m) => 10 + (6 * m) / 59), []);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
  assert.equal(fit.driftM, 0);
});

test("SAFETY: a real hill cannot be absorbed, because a revisit compares one place", () => {
  // A revisit is the same segment, direction and 15m cell at two times, so the
  // ground under both readings is identical and subtracts out exactly. A ride
  // over a mountain whose barometer held still reports no drift no matter how
  // much climbing it did.
  const steadyRide = ride(60, 6, (m) => 10 + (m < 30 ? m : 59 - m) * 0.8);
  const fit = fitAnchor(steadyRide, revisitsAt(0));
  assert.ok(fit);
  assert.equal(fit.driftRateMPerH, 0);
  assert.equal(fit.shape, "constant");
});

test("SAFETY: a movement smaller than the known leaks is not believed", () => {
  // The revisits agree in sign and are far enough apart in time, so only the
  // size of the movement is holding this back. Half a metre is inside the few
  // tenths that bucket position, unequal fix counts and the smoothing lag can
  // manufacture on their own, and MAX_PLAUSIBLE_OFFSET_M is no guard against
  // something this small. Believing it would tilt rides on noise.
  const fit = fitAnchor(ride(60, 6, () => 12), [
    { earlyAtMs: 0, lateAtMs: 35 * MINUTE, riseM: 0.5, buckets: 3, segmentId: 1 },
    { earlyAtMs: 5 * MINUTE, lateAtMs: 45 * MINUTE, riseM: 0.4, buckets: 2, segmentId: 2 },
    { earlyAtMs: 10 * MINUTE, lateAtMs: 55 * MINUTE, riseM: 0.6, buckets: 4, segmentId: 3 },
  ]);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
  assert.equal(fit.driftM, 0);
});

test("SAFETY: revisits that disagree on direction are measuring noise", () => {
  // Weather moves one way at a time. A set of comparisons split evenly on sign
  // is not a front passing, it is bucket noise, and its median is meaningless.
  const fit = fitAnchor(ride(60, 6, () => 12), [
    { earlyAtMs: 0, lateAtMs: 35 * MINUTE, riseM: 3, buckets: 3, segmentId: 1 },
    { earlyAtMs: 2 * MINUTE, lateAtMs: 40 * MINUTE, riseM: -3.2, buckets: 3, segmentId: 2 },
    { earlyAtMs: 5 * MINUTE, lateAtMs: 45 * MINUTE, riseM: 2.9, buckets: 3, segmentId: 3 },
    { earlyAtMs: 8 * MINUTE, lateAtMs: 55 * MINUTE, riseM: -3.1, buckets: 3, segmentId: 4 },
  ]);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
});

test("reports the drift it removed", () => {
  const fit = fitAnchor(ride(60, 6, (m) => (8 * m) / 59), revisitsAt(8));
  assert.ok(fit);
  assert.ok(Math.abs(fit.driftRateMPerH - 8) < 0.01, `rate ${fit.driftRateMPerH}`);
  // 59 minutes of points at 8m/h.
  assert.ok(Math.abs(fit.driftM - 8 * (59 / 60)) < 0.01, `drift ${fit.driftM}`);
  assert.ok(fit.maxM > fit.minM);
  // Counted in pairs of passes, not in buckets, and the points are every
  // terrain comparison the ride produced.
  assert.equal(fit.revisits, 4);
  assert.equal(fit.points, 360);
});

test("the level is read after the slope is taken out", () => {
  // Points bunched into the last third of the ride. Reading the level off the
  // tilted residuals would place it wherever the ride spent its time; taking
  // the slope out first puts it at the middle of the measured window, and
  // leaves the correction tracking the residual at every individual moment.
  const late: AnchorPoint[] = [];
  for (let m = 40; m < 60; m++) {
    for (let i = 0; i < 6; i++) late.push({ atMs: m * MINUTE, residualM: 20 + (10 * m) / 59 });
  }
  const fit = fitAnchor(late, revisitsAt(10 * (60 / 59)));
  assert.ok(fit);
  assert.equal(fit.shape, "ramp");
  // The window runs 0..59 minutes, so its middle is minute 29.5.
  assert.ok(Math.abs(fit.midM - (20 + (10 * 29.5) / 59)) < 0.3, `level ${fit.midM.toFixed(2)}`);
  // The property that actually matters: at any moment the correction equals
  // what the ride was reading then. A single number cannot do this, and it is
  // what puts every bucket on the same datum instead of only the average one.
  for (const m of [40, 50, 59]) {
    const wanted = 20 + (10 * m) / 59;
    assert.ok(
      Math.abs(fit.offsetAt(m * MINUTE) - wanted) < 0.3,
      `at minute ${m}: ${fit.offsetAt(m * MINUTE).toFixed(2)} vs ${wanted.toFixed(2)}`,
    );
  }
});

test("outliers in the revisits do not set the slope", () => {
  const fit = fitAnchor(ride(60, 6, () => 20), [
    { earlyAtMs: 0, lateAtMs: 30 * MINUTE, riseM: 2, buckets: 3, segmentId: 1 },
    { earlyAtMs: 5 * MINUTE, lateAtMs: 35 * MINUTE, riseM: 2.1, buckets: 3, segmentId: 2 },
    { earlyAtMs: 10 * MINUTE, lateAtMs: 40 * MINUTE, riseM: 1.9, buckets: 3, segmentId: 3 },
    { earlyAtMs: 15 * MINUTE, lateAtMs: 45 * MINUTE, riseM: -14, buckets: 1, segmentId: 4 },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 50 * MINUTE, riseM: 15, buckets: 1, segmentId: 5 },
  ]);
  assert.ok(fit);
  assert.ok(Math.abs(fit.driftRateMPerH - 4) < 0.5, `rate ${fit.driftRateMPerH}`);
});

test("outliers in the terrain points do not move the level", () => {
  const clean = ride(60, 6, () => 20);
  const withBridges: AnchorPoint[] = [
    ...clean,
    { atMs: 5 * MINUTE, residualM: -55 },
    { atMs: 6 * MINUTE, residualM: 58 },
    { atMs: 50 * MINUTE, residualM: -50 },
  ];
  const a = fitAnchor(clean, revisitsAt(3));
  const b = fitAnchor(withBridges, revisitsAt(3));
  assert.ok(a && b);
  assert.ok(Math.abs(a.midM - b.midM) < 0.5, `${a.midM.toFixed(2)} vs ${b.midM.toFixed(2)}`);
});

test("too few points is unanchored, not a guess", () => {
  assert.equal(fitAnchor(ride(MIN_POINTS_FOR_ANCHOR - 1, 1, () => 5), revisitsAt(5)), null);
});

test("an implausible offset stays unanchored", () => {
  assert.equal(fitAnchor(ride(60, 6, () => MAX_PLAUSIBLE_OFFSET_M + 10), revisitsAt(3)), null);
});

test("fewer than three revisits keeps the single number", () => {
  const fit = fitAnchor(ride(60, 6, () => 12), revisitsAt(6, { count: 2 }));
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
});

test("revisits too close together in time are ignored", () => {
  // Minutes apart, so a few tenths of bucket noise would imply several metres
  // an hour. Not a measurement of the weather.
  const fit = fitAnchor(ride(60, 6, () => 12), [
    { earlyAtMs: 0, lateAtMs: 5 * MINUTE, riseM: 2.4, buckets: 3, segmentId: 1 },
    { earlyAtMs: 10 * MINUTE, lateAtMs: 14 * MINUTE, riseM: 2.5, buckets: 3, segmentId: 2 },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 23 * MINUTE, riseM: 2.3, buckets: 3, segmentId: 3 },
    { earlyAtMs: 30 * MINUTE, lateAtMs: 32 * MINUTE, riseM: 2.6, buckets: 3, segmentId: 4 },
  ]);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
});

test("a drift too fast for weather falls back to the single number", () => {
  // 90m in an hour is more than ten times the worst drift in the archive, so
  // it is something other than the weather -- but the ride still gets the old
  // correction rather than being thrown away.
  const fit = fitAnchor(ride(60, 6, () => 10), revisitsAt(90));
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
  assert.equal(fit.driftM, 0);
});

test("a ramp plausible in the middle but absurd at one end is refused", () => {
  // Five hours at 25m/h, with revisits spread across the whole of it so the
  // ramp really does run that long. Mid-ride the correction reads a sane 5m,
  // so checking the middle alone would pass it, while the far end asks for
  // 67m -- past the one bound the single number could never breach.
  const fit = fitAnchor(ride(300, 6, () => 5), revisitsAt(25, { toMin: 300 }));
  assert.ok(fit);
  assert.equal(fit.shape, "constant", "ends outside the plausible band must be caught");
});

test("outside the stretch the drift was measured on, the correction is held flat", () => {
  // Why this is not extrapolated: the correction is applied to every run,
  // including runs that contributed no terrain points at all, and a ride with
  // partial terrain coverage has runs well outside the fitted window. An
  // unclamped line put a run two hours out at 81m. Holding it flat means the
  // furthest-out run is corrected by the same amount as the last one that was
  // actually measured, which is the honest answer when the evidence runs out.
  const fit = fitAnchor(ride(60, 6, (m) => (10 * m) / 59), revisitsAt(10));
  assert.ok(fit);
  assert.equal(fit.shape, "ramp");

  const atWindowEnd = fit.offsetAt(59 * MINUTE);
  const atWindowStart = fit.offsetAt(0);
  assert.equal(fit.offsetAt(3 * 60 * MINUTE), atWindowEnd, "a run hours later must not keep climbing");
  assert.equal(fit.offsetAt(-90 * MINUTE), atWindowStart, "nor may one before the window keep falling");

  // And because of that clamp, minM and maxM really are the extremes over all
  // time rather than the values at two sampled instants -- which is what makes
  // checking them a bound on the correction everywhere.
  for (const minute of [-500, -60, 0, 17, 59, 120, 1000]) {
    const offset = fit.offsetAt(minute * MINUTE);
    assert.ok(
      offset >= fit.minM - 1e-9 && offset <= fit.maxM + 1e-9,
      `offset at minute ${minute} is ${offset.toFixed(2)}, outside [${fit.minM.toFixed(2)}, ${fit.maxM.toFixed(2)}]`,
    );
  }
});

// --- Defect 1: the ramp may only span time that was actually observed --------
//
// These four carry the review's own numbers. Each one passed the suite that
// shipped with the original PR, which is the point: the guards were mutation
// tested and the eval exited 0, and none of it could see a window built by
// taking the union of disjoint observations.

test("REGRESSION: disjoint observations do not license a ramp across the gaps", () => {
  // The review's example, exactly. Three 31-minute observations at 0, 100 and
  // 209 minutes. Their union is 0..240, and they cover 93 minutes of it; the
  // ramp used to be drawn across all 240, inventing a slope for 147 minutes
  // nobody watched. Each rise is 1.6m, the file's own quoted median
  // disagreement, and the correction that produced was 12.39m.
  const disjoint: Revisit[] = [
    { earlyAtMs: 0, lateAtMs: 31 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 1 },
    { earlyAtMs: 100 * MINUTE, lateAtMs: 131 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 2 },
    { earlyAtMs: 209 * MINUTE, lateAtMs: 240 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 3 },
  ];
  assert.equal(fitDriftRate(disjoint), null, "no gap-free block holds a quorum");

  const fit = fitAnchor(ride(240, 3, () => 10), disjoint);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
  assert.equal(fit.driftM, 0);
  // The number the defect produced, named so a regression is unmistakable.
  assert.ok(
    Math.abs(fit.maxM - fit.minM) < 1e-9,
    `correction spans ${(fit.maxM - fit.minM).toFixed(2)}m; the defect produced 12.39m`,
  );
});

test("REGRESSION: a short observation may not set the slope for a long window", () => {
  // The same leak by a different route, and the one a gap-free window alone
  // does not catch. Here the observations overlap, so they do form one block --
  // but two of them span half an hour and the block runs four hours. The median
  // rate is then the short pairs' rate, applied over eight times the stretch it
  // was measured on, which multiplies their leak by the same factor.
  const stackedShort: Revisit[] = [
    { earlyAtMs: 0, lateAtMs: 240 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 1 },
    { earlyAtMs: 0, lateAtMs: 31 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 2 },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 51 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 3 },
  ];
  assert.equal(fitDriftRate(stackedShort), null, "reach past the evidence is refused");

  const fit = fitAnchor(ride(240, 3, () => 10), stackedShort);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
});

test("observations that tile a stretch DO license a ramp across it", () => {
  // The other half of the rule, and the reason it is a ratio rather than a ban.
  // Three abutting 40-minute observations cover 0..120 with no gap, so the ramp
  // reaches exactly three times its shortest observation and no further. This
  // is the densest honest evidence the feature can get, and it must survive.
  const chained: Revisit[] = [
    { earlyAtMs: 0, lateAtMs: 40 * MINUTE, riseM: 2, buckets: 3, segmentId: 1 },
    { earlyAtMs: 40 * MINUTE, lateAtMs: 80 * MINUTE, riseM: 2, buckets: 3, segmentId: 2 },
    { earlyAtMs: 80 * MINUTE, lateAtMs: 120 * MINUTE, riseM: 2, buckets: 3, segmentId: 3 },
  ];
  const drift = fitDriftRate(chained);
  assert.ok(drift, "abutting observations leave no unobserved instant");
  assert.equal(drift.fromMs, 0);
  assert.equal(drift.toMs, 120 * MINUTE);
  assert.ok(Math.abs(drift.rateMPerH - 3) < 1e-9, `rate ${drift.rateMPerH}`);
  assert.ok(Math.abs(drift.windowToGapRatio - 3) < 1e-9, `ratio ${drift.windowToGapRatio}`);
});

test("the window is the largest covered block, not the span of everything", () => {
  // A ride with a dense hour and one stray observation hours later. The stray is
  // real evidence about its own stretch and no evidence at all about the hour,
  // so it must neither stretch the window nor vote on the rate.
  const mixed: Revisit[] = [
    { earlyAtMs: 0, lateAtMs: 35 * MINUTE, riseM: 2, buckets: 3, segmentId: 1 },
    { earlyAtMs: 10 * MINUTE, lateAtMs: 45 * MINUTE, riseM: 2, buckets: 3, segmentId: 2 },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 55 * MINUTE, riseM: 2, buckets: 3, segmentId: 3 },
    { earlyAtMs: 400 * MINUTE, lateAtMs: 440 * MINUTE, riseM: 30, buckets: 3, segmentId: 4 },
  ];
  const drift = fitDriftRate(mixed);
  assert.ok(drift);
  assert.equal(drift.fromMs, 0);
  assert.equal(drift.toMs, 55 * MINUTE, "the stray must not stretch the window");
  assert.equal(drift.pairs, 3, "nor vote on the rate");
  assert.ok(Math.abs(drift.rateMPerH - (2 / (35 / 60))) < 1e-9, `rate ${drift.rateMPerH}`);
});

test("largestCoveredBlock merges what touches and splits what does not", () => {
  const at = (fromMin: number, toMin: number, segmentId = 1): Revisit => ({
    earlyAtMs: fromMin * MINUTE,
    lateAtMs: toMin * MINUTE,
    riseM: 1,
    buckets: 1,
    segmentId,
  });

  assert.equal(largestCoveredBlock([]), null);

  const overlapping = largestCoveredBlock([at(0, 30), at(20, 50), at(45, 70)]);
  assert.ok(overlapping);
  assert.equal(overlapping.fromMs, 0);
  assert.equal(overlapping.toMs, 70 * MINUTE);
  assert.equal(overlapping.members.length, 3);

  // Abutting exactly: the instant they share was observed by both, so there is
  // no gap between them.
  const abutting = largestCoveredBlock([at(0, 30), at(30, 60)]);
  assert.ok(abutting);
  assert.equal(abutting.toMs, 60 * MINUTE);
  assert.equal(abutting.members.length, 2);

  // One minute apart is a gap, and the bigger side wins.
  const split = largestCoveredBlock([at(0, 30), at(31, 60), at(55, 90)]);
  assert.ok(split);
  assert.equal(split.fromMs, 31 * MINUTE);
  assert.equal(split.toMs, 90 * MINUTE);
  assert.equal(split.members.length, 2);

  // Equal-sized blocks: the longer one, so the ride keeps the stretch it can
  // say the most about.
  const tied = largestCoveredBlock([at(0, 10), at(100, 160)]);
  assert.ok(tied);
  assert.equal(tied.fromMs, 100 * MINUTE);
  assert.equal(tied.toMs, 160 * MINUTE);

  // Unsorted input must not change the answer.
  const shuffled = largestCoveredBlock([at(45, 70), at(0, 30), at(20, 50)]);
  assert.ok(shuffled);
  assert.equal(shuffled.fromMs, 0);
  assert.equal(shuffled.toMs, 70 * MINUTE);
});

// --- Defect 2: a quorum has to be independent evidence -----------------------

test("REGRESSION: a quorum may not come from a single street", () => {
  // Three pairs, all on segment 1. Time-wise they are impeccable: gap-free,
  // well separated, in agreement. They are still one place, one line through
  // one 15m cell, and whatever systematic error lives there is present in all
  // three. The review's phrasing was "two increments wearing three hats"; this
  // is the hats after the increments were fixed.
  const oneStreet = revisitsAt(6, { site: 1 });
  assert.equal(fitDriftRate(oneStreet), null);

  const fit = fitAnchor(ride(60, 6, (m) => (6 * m) / 59), oneStreet);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");

  // The identical evidence spread over two streets is believed, so this test is
  // measuring the site rule and not something else that happens to also refuse.
  assert.ok(fitDriftRate(revisitsAt(6)));
});

test("every rejection path returns exactly the old single number", () => {
  // The safety property that bounds the blast radius: this can only differ from
  // the previous behaviour when a ride has measured its own drift.
  const points = ride(60, 6, (m) => 10 + m * 0.05);
  const cases: Revisit[][] = [
    [],
    revisitsAt(6, { count: 2 }),
    revisitsAt(90),
    revisitsAt(0),
    [
      { earlyAtMs: 0, lateAtMs: 5 * MINUTE, riseM: 2.4, buckets: 3, segmentId: 1 },
      { earlyAtMs: 10 * MINUTE, lateAtMs: 14 * MINUTE, riseM: 2.5, buckets: 3, segmentId: 2 },
      { earlyAtMs: 20 * MINUTE, lateAtMs: 23 * MINUTE, riseM: 2.3, buckets: 3, segmentId: 3 },
    ],
  ];
  for (const revisits of cases) {
    const fit = fitAnchor(points, revisits);
    const old = fitAnchor(points, revisits, { allowRamp: false });
    assert.ok(fit && old);
    assert.equal(fit.shape, "constant");
    assert.equal(fit.midM, old.midM);
    assert.equal(fit.offsetAt(0), old.offsetAt(0));
    // Not just at one instant: a constant fit must be constant everywhere.
    assert.equal(fit.offsetAt(10 * 60 * MINUTE), old.offsetAt(0));
  }
});

test("the correction is evaluated at the moment asked for", () => {
  const fit = fitAnchor(ride(60, 6, () => 0), revisitsAt(10));
  assert.ok(fit);
  const early = fit.offsetAt(0);
  const late = fit.offsetAt(59 * MINUTE);
  assert.ok(late - early > 9, `should span the drift, got ${(late - early).toFixed(2)}m`);
  // Linear: the midpoint sits halfway between the ends.
  assert.ok(Math.abs(fit.offsetAt(29.5 * MINUTE) - (early + late) / 2) < 0.01);
});

test("fitDriftRate reads a rate out of pairs of different lengths", () => {
  const drift = fitDriftRate([
    { earlyAtMs: 0, lateAtMs: 60 * MINUTE, riseM: 5, buckets: 3, segmentId: 1 },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 50 * MINUTE, riseM: 2.5, buckets: 2, segmentId: 2 },
    { earlyAtMs: 30 * MINUTE, lateAtMs: 75 * MINUTE, riseM: 3.75, buckets: 4, segmentId: 3 },
  ]);
  assert.ok(drift != null);
  assert.ok(Math.abs(drift.rateMPerH - 5) < 0.01, `expected 5 m/h, got ${drift.rateMPerH}`);
  assert.equal(drift.pairs, 3);
  // The window is the union of the pairs, not any single one of them: it is
  // every moment at which the drift was under observation.
  assert.equal(drift.fromMs, 0);
  assert.equal(drift.toMs, 75 * MINUTE);
});

test("fitDriftRate refuses when the pairs are all short", () => {
  assert.equal(
    fitDriftRate([
      { earlyAtMs: 0, lateAtMs: MINUTE, riseM: 1, buckets: 2, segmentId: 1 },
      { earlyAtMs: 5 * MINUTE, lateAtMs: 6.5 * MINUTE, riseM: 1, buckets: 2, segmentId: 2 },
      { earlyAtMs: 9 * MINUTE, lateAtMs: 11 * MINUTE, riseM: 1, buckets: 2, segmentId: 3 },
    ]),
    null,
  );
});

test("a short pair does not count towards the quorum of three", () => {
  // Two long pairs and one short one. The short pair is dropped before the
  // count, so this is two pairs and must not fit -- otherwise a ride could
  // reach the quorum on comparisons that were explicitly ruled out.
  assert.equal(
    fitDriftRate([
      { earlyAtMs: 0, lateAtMs: 35 * MINUTE, riseM: 3, buckets: 3, segmentId: 1 },
      { earlyAtMs: 10 * MINUTE, lateAtMs: 50 * MINUTE, riseM: 3.4, buckets: 3, segmentId: 2 },
      { earlyAtMs: 20 * MINUTE, lateAtMs: 24 * MINUTE, riseM: 0.3, buckets: 3, segmentId: 3 },
    ]),
    null,
  );
});
