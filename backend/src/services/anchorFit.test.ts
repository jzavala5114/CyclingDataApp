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
// `site` defaults to a different street per pair, because the ordinary case this
// helper stands for is a ride crossing several streets twice. Pass a fixed
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
      siteKey: `street-${site ?? i + 1}`,
    };
  });
}

// The ramp is OFF by default -- that default is the shipped verdict, see
// FitOptions in anchorFit.ts. Every test in this file is about the ramp, so they
// opt in through this helper. The handful that mean to exercise the shipped
// single-number path pass `{ allowRamp: false }` themselves and say why.
function fitRamp(points: AnchorPoint[], revisits: Revisit[] = []) {
  return fitAnchor(points, revisits, { allowRamp: true });
}

test("the shipped default does not ramp, whatever the revisits say", () => {
  // The guard on the blocker: prose in a commit message is not a verdict, and
  // production calls fitAnchor without options. If this test ever fails, a ride
  // saved through POST /sessions/:id/end is getting a correction the eval has
  // measured as a regression.
  const points = ride(60, 6, (m) => 20 + (8 * m) / 59);
  const revisits = revisitsAt(8 * (60 / 59));
  assert.ok(fitRamp(points, revisits)?.shape === "ramp", "the ramp still works when asked for");

  const shipped = fitAnchor(points, revisits);
  assert.ok(shipped);
  assert.equal(shipped.shape, "constant");
  assert.equal(shipped.driftM, 0);
  assert.equal(shipped.offsetAt(0), shipped.offsetAt(59 * MINUTE));
});

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

  const ramp = fitRamp(points, revisits);
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
  const fit = fitRamp(ride(60, 6, (m) => 10 + (6 * m) / 59), []);
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
  const fit = fitRamp(steadyRide, revisitsAt(0));
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
  const fit = fitRamp(ride(60, 6, () => 12), [
    { earlyAtMs: 0, lateAtMs: 35 * MINUTE, riseM: 0.5, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 5 * MINUTE, lateAtMs: 45 * MINUTE, riseM: 0.4, buckets: 2, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 10 * MINUTE, lateAtMs: 55 * MINUTE, riseM: 0.6, buckets: 4, segmentId: 3, siteKey: "street-3" },
  ]);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
  assert.equal(fit.driftM, 0);
});

test("SAFETY: revisits that disagree on direction are measuring noise", () => {
  // Weather moves one way at a time. A set of comparisons split evenly on sign
  // is not a front passing, it is bucket noise, and its median is meaningless.
  const fit = fitRamp(ride(60, 6, () => 12), [
    { earlyAtMs: 0, lateAtMs: 35 * MINUTE, riseM: 3, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 2 * MINUTE, lateAtMs: 40 * MINUTE, riseM: -3.2, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 5 * MINUTE, lateAtMs: 45 * MINUTE, riseM: 2.9, buckets: 3, segmentId: 3, siteKey: "street-3" },
    { earlyAtMs: 8 * MINUTE, lateAtMs: 55 * MINUTE, riseM: -3.1, buckets: 3, segmentId: 4, siteKey: "street-4" },
  ]);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
});

test("reports the drift it removed", () => {
  const fit = fitRamp(ride(60, 6, (m) => (8 * m) / 59), revisitsAt(8));
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
  const fit = fitRamp(late, revisitsAt(10 * (60 / 59)));
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
  const fit = fitRamp(ride(60, 6, () => 20), [
    { earlyAtMs: 0, lateAtMs: 30 * MINUTE, riseM: 2, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 5 * MINUTE, lateAtMs: 35 * MINUTE, riseM: 2.1, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 10 * MINUTE, lateAtMs: 40 * MINUTE, riseM: 1.9, buckets: 3, segmentId: 3, siteKey: "street-3" },
    { earlyAtMs: 15 * MINUTE, lateAtMs: 45 * MINUTE, riseM: -14, buckets: 1, segmentId: 4, siteKey: "street-4" },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 50 * MINUTE, riseM: 15, buckets: 1, segmentId: 5, siteKey: "street-5" },
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
  const a = fitRamp(clean, revisitsAt(3));
  const b = fitRamp(withBridges, revisitsAt(3));
  assert.ok(a && b);
  assert.ok(Math.abs(a.midM - b.midM) < 0.5, `${a.midM.toFixed(2)} vs ${b.midM.toFixed(2)}`);
});

test("too few points is unanchored, not a guess", () => {
  assert.equal(fitRamp(ride(MIN_POINTS_FOR_ANCHOR - 1, 1, () => 5), revisitsAt(5)), null);
});

test("an implausible offset stays unanchored", () => {
  assert.equal(fitRamp(ride(60, 6, () => MAX_PLAUSIBLE_OFFSET_M + 10), revisitsAt(3)), null);
});

test("fewer than three revisits keeps the single number", () => {
  const fit = fitRamp(ride(60, 6, () => 12), revisitsAt(6, { count: 2 }));
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
});

test("revisits too close together in time are ignored", () => {
  // Minutes apart, so a few tenths of bucket noise would imply several metres
  // an hour. Not a measurement of the weather.
  const fit = fitRamp(ride(60, 6, () => 12), [
    { earlyAtMs: 0, lateAtMs: 5 * MINUTE, riseM: 2.4, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 10 * MINUTE, lateAtMs: 14 * MINUTE, riseM: 2.5, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 23 * MINUTE, riseM: 2.3, buckets: 3, segmentId: 3, siteKey: "street-3" },
    { earlyAtMs: 30 * MINUTE, lateAtMs: 32 * MINUTE, riseM: 2.6, buckets: 3, segmentId: 4, siteKey: "street-4" },
  ]);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
});

test("a drift too fast for weather falls back to the single number", () => {
  // 90m in an hour is more than ten times the worst drift in the archive, so
  // it is something other than the weather -- but the ride still gets the old
  // correction rather than being thrown away.
  const fit = fitRamp(ride(60, 6, () => 10), revisitsAt(90));
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
  assert.equal(fit.driftM, 0);
});

test("a ramp plausible in the middle but absurd at one end is refused", () => {
  // Five hours at 25m/h, with revisits spread across the whole of it so the
  // ramp really does run that long. Mid-ride the correction reads a sane 5m,
  // so checking the middle alone would pass it, while the far end asks for
  // 67m -- past the one bound the single number could never breach.
  const fit = fitRamp(ride(300, 6, () => 5), revisitsAt(25, { toMin: 300 }));
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
  const fit = fitRamp(ride(60, 6, (m) => (10 * m) / 59), revisitsAt(10));
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
    { earlyAtMs: 0, lateAtMs: 31 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 100 * MINUTE, lateAtMs: 131 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 209 * MINUTE, lateAtMs: 240 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 3, siteKey: "street-3" },
  ];
  assert.equal(fitDriftRate(disjoint), null, "no gap-free block holds a quorum");

  const fit = fitRamp(ride(240, 3, () => 10), disjoint);
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
    { earlyAtMs: 0, lateAtMs: 240 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 0, lateAtMs: 31 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 51 * MINUTE, riseM: 1.6, buckets: 3, segmentId: 3, siteKey: "street-3" },
  ];
  assert.equal(fitDriftRate(stackedShort), null, "reach past the evidence is refused");

  const fit = fitRamp(ride(240, 3, () => 10), stackedShort);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");
});

test("observations that tile a stretch DO license a ramp across it", () => {
  // The other half of the rule, and the reason it is a ratio rather than a ban.
  // Three abutting 40-minute observations cover 0..120 with no gap, so the ramp
  // reaches exactly three times its shortest observation and no further. This
  // is the densest honest evidence the feature can get, and it must survive.
  const chained: Revisit[] = [
    { earlyAtMs: 0, lateAtMs: 40 * MINUTE, riseM: 2, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 40 * MINUTE, lateAtMs: 80 * MINUTE, riseM: 2, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 80 * MINUTE, lateAtMs: 120 * MINUTE, riseM: 2, buckets: 3, segmentId: 3, siteKey: "street-3" },
  ];
  const drift = fitDriftRate(chained);
  assert.ok(drift, "abutting observations leave no unobserved instant");
  assert.equal(drift.fromMs, 0);
  assert.equal(drift.toMs, 120 * MINUTE);
  assert.ok(Math.abs(drift.rateMPerH - 3) < 1e-9, `rate ${drift.rateMPerH}`);
  assert.ok(Math.abs(drift.contradictionM) < 1e-9, `contradiction ${drift.contradictionM}`);

  // And a LONGER chain must not be refused for being longer. An earlier version
  // of this rule capped the window at three times its shortest observation,
  // which accepted three abutting observations and rejected four -- so adding
  // evidence took the feature away. Five tile 200 minutes with nothing unwatched
  // and contradict nothing, so they are the best evidence this can get.
  for (const count of [4, 5, 6]) {
    const longer: Revisit[] = Array.from({ length: count }, (_, i) => ({
      earlyAtMs: i * 40 * MINUTE,
      lateAtMs: (i + 1) * 40 * MINUTE,
      riseM: 2,
      buckets: 3,
      segmentId: i + 1,
      siteKey: `street-${i + 1}`,
    }));
    const fit = fitDriftRate(longer);
    assert.ok(fit, `${count} abutting observations should still fit`);
    assert.equal(fit.toMs, count * 40 * MINUTE);
    assert.ok(Math.abs(fit.rateMPerH - 3) < 1e-9, `rate ${fit.rateMPerH} at count ${count}`);
  }
});

test("REGRESSION: the ride's longest observation can veto the median", () => {
  // Three pairs, every one of them clean by the other rules: they agree on sign,
  // clear the meaningfulness floor, sit on three streets, and form one gap-free
  // block. But two are half-hour observations and the third watched the whole
  // 90 minutes end to end and saw the ride move 1m. The median of the per-pair
  // RATES is 2 m/h, which claims 3m across that same 90 minutes -- three times
  // what the one observation with a direct claim on the window actually saw.
  //
  // The median treats a 30-minute vote and a 90-minute vote as equal, so short
  // pairs can outvote the long one. Nothing else here notices.
  const outvoted: Revisit[] = [
    { earlyAtMs: 0, lateAtMs: 90 * MINUTE, riseM: 1, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 0, lateAtMs: 30 * MINUTE, riseM: 1, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 50 * MINUTE, riseM: 1, buckets: 3, segmentId: 3, siteKey: "street-3" },
  ];
  assert.equal(fitDriftRate(outvoted), null);

  const fit = fitRamp(ride(90, 4, () => 10), outvoted);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");

  // The same three intervals, with every pair agreeing at a steady 3 m/h, are
  // believed. So this is measuring the contradiction and not the shape of the
  // input -- and the rises are kept above MIN_MEANINGFUL_RISE_M so that floor is
  // not what decides either case.
  const agreeing = outvoted.map((r) => ({
    ...r,
    riseM: (3 * (r.lateAtMs - r.earlyAtMs)) / (60 * MINUTE),
  }));
  assert.ok(agreeing.every((r) => Math.abs(r.riseM) >= 1), "rises must clear the floor");
  const ok = fitDriftRate(agreeing);
  assert.ok(ok, "pairs that agree with the longest observation still fit");
  assert.ok(Math.abs(ok.rateMPerH - 3) < 1e-9, `rate ${ok.rateMPerH}`);
  assert.ok(ok.contradictionM < 1e-9, `contradiction ${ok.contradictionM}`);
});

test("the window is the largest covered block, not the span of everything", () => {
  // A ride with a dense hour and one stray observation hours later. The stray is
  // real evidence about its own stretch and no evidence at all about the hour,
  // so it must neither stretch the window nor vote on the rate.
  const mixed: Revisit[] = [
    { earlyAtMs: 0, lateAtMs: 35 * MINUTE, riseM: 2, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 10 * MINUTE, lateAtMs: 45 * MINUTE, riseM: 2, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 55 * MINUTE, riseM: 2, buckets: 3, segmentId: 3, siteKey: "street-3" },
    { earlyAtMs: 400 * MINUTE, lateAtMs: 440 * MINUTE, riseM: 30, buckets: 3, segmentId: 4, siteKey: "street-4" },
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
    siteKey: `street-${segmentId}`,
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

  const fit = fitRamp(ride(60, 6, (m) => (6 * m) / 59), oneStreet);
  assert.ok(fit);
  assert.equal(fit.shape, "constant");

  // The identical evidence spread over two streets is believed, so this test is
  // measuring the site rule and not something else that happens to also refuse.
  assert.ok(fitDriftRate(revisitsAt(6)));
});

// --- The guard constants themselves -----------------------------------------
//
// A review swept every constant in anchorFit.ts against this suite and found
// most of them free to move a long way with everything still green:
// MIN_MEANINGFUL_RISE_M could be cut to 0.55, MIN_REVISIT_GAP_S to 310 seconds,
// MIN_SIGN_AGREEMENT to 0.51, MAX_DRIFT_RATE_M_PER_H doubled to 60. A number
// nothing pins is a number anyone may quietly change, and each of these is the
// only thing standing between the fit and a class of input it must refuse.
//
// Each test below straddles one boundary: an input just inside it is believed,
// the same input just outside it is not. Moving the constant breaks one side or
// the other.

test("BOUNDARY: MIN_REVISIT_GAP_S is half an hour, and it bites", () => {
  const pairsAt = (gapMin: number): Revisit[] =>
    [0, 1, 2].map((i) => ({
      earlyAtMs: i * 2 * MINUTE,
      lateAtMs: i * 2 * MINUTE + gapMin * MINUTE,
      riseM: 2,
      buckets: 3,
      segmentId: i + 1,
      siteKey: `street-${i + 1}`,
    }));
  assert.ok(fitDriftRate(pairsAt(31)), "31 minutes apart is a usable revisit");
  assert.equal(fitDriftRate(pairsAt(29)), null, "29 minutes apart is not");
  // Exactly on the floor counts, since the filter is `>=`.
  assert.ok(fitDriftRate(pairsAt(30)), "exactly 30 minutes counts");
});

test("BOUNDARY: MIN_MEANINGFUL_RISE_M is one metre, and it bites", () => {
  const risingBy = (riseM: number): Revisit[] =>
    [0, 1, 2].map((i) => ({
      earlyAtMs: i * 2 * MINUTE,
      lateAtMs: i * 2 * MINUTE + 35 * MINUTE,
      riseM,
      buckets: 3,
      segmentId: i + 1,
      siteKey: `street-${i + 1}`,
    }));
  assert.ok(fitDriftRate(risingBy(1.05)), "just over a metre is believed");
  assert.equal(fitDriftRate(risingBy(0.95)), null, "just under a metre is not");
});

test("BOUNDARY: MIN_SIGN_AGREEMENT is two thirds, and it bites", () => {
  // Six pairs: four agreeing is exactly 2/3 and passes, three is 1/2 and fails.
  const withDisagreeing = (disagreeing: number): Revisit[] =>
    Array.from({ length: 6 }, (_, i) => ({
      earlyAtMs: i * 2 * MINUTE,
      lateAtMs: i * 2 * MINUTE + 35 * MINUTE,
      riseM: i < disagreeing ? -2 : 2,
      buckets: 3,
      segmentId: i + 1,
      siteKey: `street-${i + 1}`,
    }));
  assert.ok(fitDriftRate(withDisagreeing(2)), "four of six agreeing is exactly the floor");
  assert.equal(fitDriftRate(withDisagreeing(3)), null, "three of six is not");
});

test("BOUNDARY: MAX_DRIFT_RATE_M_PER_H is 30, and it bites", () => {
  const atRate = (rateMPerH: number): Revisit[] =>
    [0, 1, 2].map((i) => ({
      earlyAtMs: i * 2 * MINUTE,
      lateAtMs: i * 2 * MINUTE + 35 * MINUTE,
      riseM: (rateMPerH * 35) / 60,
      buckets: 3,
      segmentId: i + 1,
      siteKey: `street-${i + 1}`,
    }));
  assert.ok(fitDriftRate(atRate(29)), "29 m/h is a brisk front");
  assert.equal(fitDriftRate(atRate(31)), null, "31 m/h is a broken ride");
});

test("BOUNDARY: MAX_CONTRADICTION_FRACTION is half the longest rise, and it bites", () => {
  // One 60-minute observation saying the ride rose 2m, plus two short ones
  // pulling the median rate up. Allowed disagreement is 1m + 0.5 * 2m = 2m, so
  // the ramp may predict up to 4m over that hour and no more.
  const withShortRate = (shortRateMPerH: number): Revisit[] => [
    { earlyAtMs: 0, lateAtMs: 60 * MINUTE, riseM: 2, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 0, lateAtMs: 31 * MINUTE, riseM: (shortRateMPerH * 31) / 60, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 25 * MINUTE, lateAtMs: 56 * MINUTE, riseM: (shortRateMPerH * 31) / 60, buckets: 3, segmentId: 3, siteKey: "street-3" },
  ];
  // Median rate 3.9 m/h predicts 3.9m over the hour: 1.9m of disagreement, inside 2m.
  assert.ok(fitDriftRate(withShortRate(3.9)), "a disagreement the leaks can explain is allowed");
  // Median rate 4.2 m/h predicts 4.2m: 2.2m of disagreement, outside 2m.
  assert.equal(fitDriftRate(withShortRate(4.2)), null, "one the leaks cannot is refused");
});

test("BOUNDARY: the quorum is rechecked AFTER the block is chosen", () => {
  // The seam between defect 1's fix and defect 2's. Three usable pairs enter,
  // but one falls outside the largest covered block, so only two back the
  // window -- and two is not a quorum. Without the second check the fit would
  // proceed on them, which is the one line in the new logic a mutation sweep
  // found untested.
  const twoInBlockOneOut: Revisit[] = [
    { earlyAtMs: 0, lateAtMs: 35 * MINUTE, riseM: 2, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 10 * MINUTE, lateAtMs: 45 * MINUTE, riseM: 2, buckets: 3, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 400 * MINUTE, lateAtMs: 440 * MINUTE, riseM: 2, buckets: 3, segmentId: 3, siteKey: "street-3" },
  ];
  const block = largestCoveredBlock(twoInBlockOneOut);
  assert.ok(block);
  assert.equal(block.members.length, 2, "the stray is its own block");
  assert.equal(fitDriftRate(twoInBlockOneOut), null, "two pairs in the block is not a quorum");

  // A third pair inside the block, and the same input is believed.
  const threeInBlock = [
    ...twoInBlockOneOut.slice(0, 2),
    { earlyAtMs: 20 * MINUTE, lateAtMs: 55 * MINUTE, riseM: 2, buckets: 3, segmentId: 4, siteKey: "street-4" },
  ];
  assert.ok(fitDriftRate(threeInBlock));
});

test("REGRESSION: consecutive blocks of ONE street are ONE site", () => {
  // Session 76's actual shape, and the reason `siteKey` exists rather than
  // counting segment ids. A segments row is an OSM way split at every junction
  // and cut again into pieces, so riding one trail end to end twice produces a
  // row of revisits on different segment ids that are all the same place. The
  // ride reported "15 distinct sites" and they were fifteen consecutive pieces
  // of Culebras Trail.
  const oneStreet: Revisit[] = [101, 102, 103].map((segmentId, i) => ({
    earlyAtMs: i * 2 * MINUTE,
    lateAtMs: i * 2 * MINUTE + 35 * MINUTE,
    riseM: 2,
    buckets: 3,
    segmentId,
    siteKey: "name:Culebras Trail",
  }));
  assert.equal(fitDriftRate(oneStreet), null, "three pieces of one trail are not three sites");

  // The same three comparisons with one of them on a different street clear the
  // quorum -- so this pins MIN_REVISIT_SITES at exactly two as well: raise it and
  // this half fails, lower it and the half above does.
  const twoStreets = [
    ...oneStreet.slice(0, 2),
    { ...oneStreet[2], segmentId: 200, siteKey: "name:Ute Valley Regional Trail" },
  ];
  const drift = fitDriftRate(twoStreets);
  assert.ok(drift, "two streets is a quorum");
  assert.equal(drift.sites, 2);
});

test("BOUNDARY: MIN_SIGN_AGREEMENT is two thirds and not three fifths", () => {
  // Five pairs, three agreeing, is 0.6 -- under two thirds and over any threshold
  // someone might round it down to. The six-pair test above pins the other side.
  const threeOfFive: Revisit[] = Array.from({ length: 5 }, (_, i) => ({
    earlyAtMs: i * 2 * MINUTE,
    lateAtMs: i * 2 * MINUTE + 35 * MINUTE,
    riseM: i < 2 ? -2 : 2,
    buckets: 3,
    segmentId: i + 1,
    siteKey: `street-${i + 1}`,
  }));
  assert.equal(fitDriftRate(threeOfFive), null, "three of five agreeing is not a direction");
});

test("BOUNDARY: near-equal gaps share the veto rather than one being crowned", () => {
  // A 60-minute observation that caught a bad bucket and read 10m, beside two
  // 58-minute ones that read 2m. They are the same stretch of the ride measured
  // three times, so the veto is theirs jointly and its median is 2m, which the
  // fitted rate agrees with.
  //
  // Tighten LONGEST_OBSERVATION_TOLERANCE towards 1 and the outlier alone holds
  // the veto, reads 10m against a predicted 2.07m, and refuses a ride whose
  // evidence is in fact consistent.
  const nearTies: Revisit[] = [
    { earlyAtMs: 0, lateAtMs: 60 * MINUTE, riseM: 10, buckets: 1, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 1 * MINUTE, lateAtMs: 59 * MINUTE, riseM: 2, buckets: 4, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 2 * MINUTE, lateAtMs: 60 * MINUTE, riseM: 2, buckets: 4, segmentId: 3, siteKey: "street-3" },
    { earlyAtMs: 5 * MINUTE, lateAtMs: 35 * MINUTE, riseM: 1, buckets: 3, segmentId: 4, siteKey: "street-4" },
  ];
  const drift = fitDriftRate(nearTies);
  assert.ok(drift, "one bad bucket in the longest pair must not veto the ride");
  assert.ok(drift.contradictionM < 1, `contradiction ${drift.contradictionM}`);
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
      { earlyAtMs: 0, lateAtMs: 5 * MINUTE, riseM: 2.4, buckets: 3, segmentId: 1, siteKey: "street-1" },
      { earlyAtMs: 10 * MINUTE, lateAtMs: 14 * MINUTE, riseM: 2.5, buckets: 3, segmentId: 2, siteKey: "street-2" },
      { earlyAtMs: 20 * MINUTE, lateAtMs: 23 * MINUTE, riseM: 2.3, buckets: 3, segmentId: 3, siteKey: "street-3" },
    ],
  ];
  for (const revisits of cases) {
    const fit = fitRamp(points, revisits);
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
  const fit = fitRamp(ride(60, 6, () => 0), revisitsAt(10));
  assert.ok(fit);
  const early = fit.offsetAt(0);
  const late = fit.offsetAt(59 * MINUTE);
  assert.ok(late - early > 9, `should span the drift, got ${(late - early).toFixed(2)}m`);
  // Linear: the midpoint sits halfway between the ends.
  assert.ok(Math.abs(fit.offsetAt(29.5 * MINUTE) - (early + late) / 2) < 0.01);
});

test("fitDriftRate reads a rate out of pairs of different lengths", () => {
  const drift = fitDriftRate([
    { earlyAtMs: 0, lateAtMs: 60 * MINUTE, riseM: 5, buckets: 3, segmentId: 1, siteKey: "street-1" },
    { earlyAtMs: 20 * MINUTE, lateAtMs: 50 * MINUTE, riseM: 2.5, buckets: 2, segmentId: 2, siteKey: "street-2" },
    { earlyAtMs: 30 * MINUTE, lateAtMs: 75 * MINUTE, riseM: 3.75, buckets: 4, segmentId: 3, siteKey: "street-3" },
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
      { earlyAtMs: 0, lateAtMs: MINUTE, riseM: 1, buckets: 2, segmentId: 1, siteKey: "street-1" },
      { earlyAtMs: 5 * MINUTE, lateAtMs: 6.5 * MINUTE, riseM: 1, buckets: 2, segmentId: 2, siteKey: "street-2" },
      { earlyAtMs: 9 * MINUTE, lateAtMs: 11 * MINUTE, riseM: 1, buckets: 2, segmentId: 3, siteKey: "street-3" },
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
      { earlyAtMs: 0, lateAtMs: 35 * MINUTE, riseM: 3, buckets: 3, segmentId: 1, siteKey: "street-1" },
      { earlyAtMs: 10 * MINUTE, lateAtMs: 50 * MINUTE, riseM: 3.4, buckets: 3, segmentId: 2, siteKey: "street-2" },
      { earlyAtMs: 20 * MINUTE, lateAtMs: 24 * MINUTE, riseM: 0.3, buckets: 3, segmentId: 3, siteKey: "street-3" },
    ]),
    null,
  );
});
