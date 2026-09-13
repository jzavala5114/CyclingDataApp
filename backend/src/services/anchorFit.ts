// Fits the correction that lines one ride up with the terrain model.
//
// A barometer measures change in height well and absolute height not at all,
// because the air pressure at any spot moves with the weather. So every ride
// arrives with the right shape sitting at an arbitrary level, and the model
// compares it against terrain heights to work out how far off it is.
//
// That correction used to be a single number for the whole ride, on the stated
// assumption that the error is a constant baseline error. Measurement killed
// that assumption. Taking every ride that crossed its own path a second time
// and comparing the two heights it recorded for the same ground: 33 revisits,
// median disagreement 1.57m, worst 7.36m. Session 54 came back to a segment 51
// minutes later and read 7.36m lower. A single number cannot remove a moving
// target; it takes out the average and leaves the start of the ride too high
// and the end too low, which lands as a step between neighbouring buckets.
//
// So the correction is a level plus a slope, and the two come from different
// places on purpose.
//
// **The slope does not come from the terrain model.** Fitting a line through
// the terrain residuals over time was tried and measured: it made each ride
// more consistent with itself and less consistent with other rides (cross-ride
// median 1.86m -> 1.93m). Within one ride, where you are is correlated with
// when you are, so such a line absorbs the terrain model's place-dependent
// error and tilts the ride to match it. Two rides crossing the same ground in
// opposite order then get opposite tilts.
//
// The slope comes from revisits instead: places one ride measured twice. The
// ground under both readings is the same, so the hill and the terrain model's
// error at that spot both cancel, and most of what is left is the instrument.
//
// **How much is "most".** This does not cancel exactly, and three leaks are
// known and bounded rather than waved away:
//
//   - A bucket is a 15m cell, not a point, and its height is the mean of the
//     fixes that landed in it. Two passes sample different positions inside
//     the cell. On a 6% street a 5m difference in mean position is 0.30m.
//   - The two passes may hold different numbers of fixes, so the two means are
//     means of slightly different ground.
//   - smoothElevations is a causal EMA, which lags by about 2.3 samples. In
//     distance that is 16m at 7 m/s and 7m at 3 m/s, so a fast pass and a slow
//     pass over the same cell differ by roughly 0.5m on a 6% grade. This one
//     is signed by grade and speed rather than random, so a rider who tires
//     over a long ride produces an apparent drift in one direction.
//
// Together those are a few tenths of a metre against a signal of 1.57m. That
// is why the drift has to clear MIN_MEANINGFUL_RISE_M before it is believed at
// all: below that floor the measurement cannot be told apart from the leaks,
// and the correct action is to keep the old single number.
//
// **What this reaches, measured 2026-09-13 over 34 rides: two of them.** The
// other 32 keep the single number. That is not the guards being timid, it is
// how seldom a ride measures its own drift: a revisit has to be the same
// segment, the same direction and the same 15m cell, at least half an hour
// apart, and most rides do not double back on themselves that way.
//
// Say the uncomfortable half of that plainly, because the 7.36m above is its
// number: **session 54 is not one of the two.** Its long revisits are
// out-and-backs -- three opposite-direction returns at up to 72 minutes against
// one same-direction -- and an out-and-back is deliberately not counted, for
// reasons set out over collectRevisits in sessionProcessor.ts. So the ride that
// motivated this is itself out of reach of it. Archive-wide that is 21 long
// revisits declined for direction against 30 kept, which makes them the obvious
// next lever and not a rounding error.
//
// Every rejection path returns that single number, so this can only differ
// from the previous behaviour when a ride has measured its own drift clearly.

export interface AnchorPoint {
  atMs: number;
  // Our height minus the terrain model's, at one place on the ride.
  residualM: number;
}

// One pair of passes over ground this ride covered twice, and how much higher
// it read the second time. Timestamps rather than a bare gap, because the
// correction may only be applied across the stretch the drift was measured on:
// pressure does not move at a constant rate, and a front that crosses during
// the first twenty minutes of a two-hour ride says nothing about the rest of
// it.
export interface Revisit {
  earlyAtMs: number;
  lateAtMs: number;
  riseM: number;
  // How many buckets backed this comparison. Reported for diagnostics.
  buckets: number;
}

export interface AnchorFit {
  // Metres to subtract from a measurement taken at this moment.
  offsetAt: (atMs: number) => number;
  // The extremes of the correction over all time. Because the ramp is clamped
  // outside the window the drift was measured in, these really are the bounds,
  // not just the values at two sampled instants.
  minM: number;
  maxM: number;
  driftM: number;
  // The level at the middle of the measured window, which is the closest thing
  // to the single number this replaced, and what gets reported.
  midM: number;
  driftRateMPerH: number;
  shape: "ramp" | "constant";
  points: number;
  revisits: number;
}

// Below this the level is being fit to noise, so the ride merges unanchored,
// which is what the model did before any of this existed.
export const MIN_POINTS_FOR_ANCHOR = 10;

// A revisit closer together than this divides bucket noise by too small a
// number: a few tenths of a metre over ten minutes already implies several
// metres an hour. Thirty minutes puts the same noise under 1 m/h.
const MIN_REVISIT_GAP_S = 1800;

// Distinct pairs of passes, not buckets. One out-and-back over a single block
// touches several buckets, but they all share the same two moments and the
// same disagreement, so counting buckets would let one comparison masquerade
// as a quorum.
const MIN_REVISIT_PAIRS = 3;

// How far a ride must be seen to move before the movement is believed. The
// leaks described at the top of this file are a few tenths of a metre, and
// MAX_PLAUSIBLE_OFFSET_M is no help against them because they are small. This
// is the floor that is.
const MIN_MEANINGFUL_RISE_M = 1;

// The pairs must agree on which way the ride went. Weather moves one way at a
// time; a set of comparisons split evenly on sign is measuring noise.
const MIN_SIGN_AGREEMENT = 2 / 3;

// An offset past this is not weather, it is a broken ride or a broken terrain
// lookup. Unchanged in value and meaning from the single-number version.
export const MAX_PLAUSIBLE_OFFSET_M = 60;

// Air pressure drifting 1 hPa in an hour is about 8.3m of apparent height, and
// a brisk front is a few times that. The worst drift measured across the
// archive was 8.7m/h.
const MAX_DRIFT_RATE_M_PER_H = 30;

const MS_PER_HOUR = 3_600_000;

const finite = (n: number) => Number.isFinite(n);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface DriftEstimate {
  rateMPerH: number;
  // The stretch of the ride the rate was actually measured across. Outside it
  // the correction is held flat rather than extended.
  fromMs: number;
  toMs: number;
  pairs: number;
}

// Metres per hour, or null when the ride did not measure its own drift clearly
// enough to say. Exported so the estimator can be tested on its own.
export function fitDriftRate(revisits: Revisit[]): DriftEstimate | null {
  const usable = revisits.filter(
    (r) =>
      finite(r.earlyAtMs) && finite(r.lateAtMs) && finite(r.riseM) &&
      r.lateAtMs - r.earlyAtMs >= MIN_REVISIT_GAP_S * 1000,
  );
  if (usable.length < MIN_REVISIT_PAIRS) return null;

  // The median of the per-pair rates rather than the mean, so one bucket that
  // caught a bad fix cannot set the slope for the whole ride.
  const rates = usable.map((r) => r.riseM / ((r.lateAtMs - r.earlyAtMs) / MS_PER_HOUR));
  const rateMPerH = median(rates);
  if (!finite(rateMPerH) || rateMPerH === 0) return null;
  if (Math.abs(rateMPerH) > MAX_DRIFT_RATE_M_PER_H) return null;

  // Is the movement bigger than the leaks? Judged on the rises themselves, not
  // on the rate, because a small rise over a short gap implies a large rate.
  if (median(usable.map((r) => Math.abs(r.riseM))) < MIN_MEANINGFUL_RISE_M) return null;

  // Do the pairs agree on direction?
  const agreeing = usable.filter((r) => Math.sign(r.riseM) === Math.sign(rateMPerH)).length;
  if (agreeing / usable.length < MIN_SIGN_AGREEMENT) return null;

  return {
    rateMPerH,
    fromMs: Math.min(...usable.map((r) => r.earlyAtMs)),
    toMs: Math.max(...usable.map((r) => r.lateAtMs)),
    pairs: usable.length,
  };
}

export interface FitOptions {
  // Forces the old single-number behaviour. Exists so the before/after can be
  // measured through this exact code path rather than a reimplementation of it,
  // the way tangentWindowM and disconnectPenaltyM do in the matcher.
  allowRamp?: boolean;
}

export function fitAnchor(
  points: AnchorPoint[],
  revisits: Revisit[] = [],
  { allowRamp = true }: FitOptions = {},
): AnchorFit | null {
  const clean = points.filter((p) => finite(p.atMs) && finite(p.residualM));
  if (clean.length < MIN_POINTS_FOR_ANCHOR) return null;

  const flat = (): AnchorFit | null => {
    const constantM = median(clean.map((p) => p.residualM));
    if (!finite(constantM) || Math.abs(constantM) > MAX_PLAUSIBLE_OFFSET_M) return null;
    return {
      offsetAt: () => constantM,
      minM: constantM,
      maxM: constantM,
      driftM: 0,
      midM: constantM,
      driftRateMPerH: 0,
      shape: "constant",
      points: clean.length,
      revisits: revisits.length,
    };
  };

  if (!allowRamp) return flat();

  const drift = fitDriftRate(revisits);
  if (drift == null) return flat();

  // The ramp is linear only between the first and last moment the drift was
  // actually observed, and held flat on either side. Extending it past those
  // moments would be extrapolation, and the correction is applied to runs that
  // contributed no terrain points at all -- a ride with partial terrain
  // coverage has runs well outside the fitted window. An unclamped line put a
  // run two hours out at 81m, past the one bound the single number could never
  // breach.
  const refMs = (drift.fromMs + drift.toMs) / 2;
  const rampAt = (atMs: number) => {
    const held = Math.min(drift.toMs, Math.max(drift.fromMs, atMs));
    return (drift.rateMPerH * (held - refMs)) / MS_PER_HOUR;
  };

  // Take the slope out first, then read the level off what is left. Fitting the
  // level on the tilted residuals would put it wherever the ride happened to
  // spend most of its time.
  const levelM = median(clean.map((p) => p.residualM - rampAt(p.atMs)));
  if (!finite(levelM)) return flat();

  const offsetAt = (atMs: number) => levelM + rampAt(atMs);
  // Clamping makes these the true extremes over all time, so checking them
  // bounds the correction everywhere rather than at two sampled instants.
  const endA = offsetAt(drift.fromMs);
  const endB = offsetAt(drift.toMs);
  const minM = Math.min(endA, endB);
  const maxM = Math.max(endA, endB);
  if (!finite(minM) || !finite(maxM)) return flat();
  if (Math.abs(minM) > MAX_PLAUSIBLE_OFFSET_M || Math.abs(maxM) > MAX_PLAUSIBLE_OFFSET_M) {
    return flat();
  }

  return {
    offsetAt,
    minM,
    maxM,
    driftM: endB - endA,
    midM: levelM,
    driftRateMPerH: drift.rateMPerH,
    shape: "ramp",
    points: clean.length,
    revisits: drift.pairs,
  };
}
