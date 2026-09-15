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
//
// A third leak used to sit here and is gone: smoothElevations was a causal EMA
// lagging about 2.3 samples, which on a fast pass against a slow one over the
// same cell was worth roughly 0.5m on a 6% grade, signed by grade and speed
// rather than random. It is now a forward-backward pass with exactly zero lag,
// so that term is zero rather than bounded. Two consequences follow, both
// recorded where they matter: the remaining leaks are smaller, and the reason
// collectRevisits declines opposite-direction revisits no longer holds.
//
// Together the survivors are a few tenths of a metre against a signal of 1.57m.
// That is why the drift has to clear MIN_MEANINGFUL_RISE_M before it is believed
// at all: below that floor the measurement cannot be told apart from the leaks,
// and the correct action is to keep the old single number.
//
// --- WHAT THIS ACTUALLY REACHES, AND WHY IT IS OFF ---------------------------
//
// **One ride in 38, and it does not ship.** `allowRamp` defaults to false (see
// FitOptions) and production calls fitAnchor without it, so every ride saved
// gets the single number this was meant to replace.
//
// The history is worth keeping because the numbers moved twice. A first version
// reached two rides and its eval passed. Review found four defects; fixing them
// exposed a fifth, and each one shrank the population that could honestly
// qualify:
//
//   - the ramp window was a union of disjoint observations, not a cover
//   - N passes over a cell were counted as N(N-1)/2 observations, not N-1
//   - "distinct sites" counted segment ids, and one street is many of those
//   - a revisit could compare a GPS-altitude pass against a barometric one
//   - the eval's safety proof compared a function with itself
//
// With all five fixed, `npm run eval:anchor` treats no rides at all, and
// production would treat exactly one. The feature is not wrong so much as
// starved: the evidence it needs -- the same ground, the same way round, the
// same instrument, half an hour apart, on more than one street, with no
// unwatched gap in between -- is close to absent in this archive.
//
// The obvious next lever is the one the zero-phase smoother unblocked:
// opposite-direction revisits, 21 long ones declined against 30 kept
// archive-wide. That needs the bucket index flipped and its own measurement.
//
// Every rejection path returns the single number, so this can only differ from
// the previous behaviour when a ride has measured its own drift clearly AND
// something has explicitly asked for a ramp.

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
  // Which segment the comparison was made on. Diagnostics only -- see siteKey
  // for the thing MIN_REVISIT_SITES actually counts.
  segmentId: number;
  // The PLACE the comparison was made, which is not the segment.
  //
  // A segments row is one OSM way pre-split at every intersection node and then
  // cut again into piece_index slices, so a single street ridden past two
  // junctions is three segment ids. Counting segment ids as independent sites
  // let one pass over one continuous stretch of road clear a quorum three times
  // over -- defect 2 relocated rather than removed, since the old bug multiplied
  // one comparison by pairing passes every way and this one multiplies it by
  // splitting the road.
  //
  // This was not hypothetical: session 76 was reported as covering "15 distinct
  // sites", and all fifteen were consecutive pieces of Culebras Trail.
  //
  // The caller supplies it, because the identity of a place lives in the segment
  // row and this module never sees one. See `siteKeyFor` in sessionProcessor.ts.
  siteKey: string;
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
  // How many revisit pairs the fit was HANDED. Always the input count, on both
  // the ramp and the constant path.
  //
  // This used to be the input count on one path and the number backing the ramp
  // on the other, so a diagnostic reading "revisits: 3" meant two different
  // things depending on a field printed next to it. `revisitsUsed` carries the
  // second meaning now, and the difference between them is exactly what the
  // gates threw away -- which is the more interesting number of the two.
  revisits: number;
  revisitsUsed: number;
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
//
// collectRevisits now emits only time-adjacent passes, so N passes over a cell
// arrive as the N-1 increments they actually contain rather than N(N-1)/2
// restatements of them. Before that fix three passes over a single cell cleared
// this quorum with two increments.
const MIN_REVISIT_PAIRS = 3;

// ...and from more than one street. The pairs being independent in time is not
// the same as their being independent measurements: four passes over one 15m
// cell give three honest increments that nonetheless share a single sampling
// position, a single set of surrounding terrain, and whatever systematic error
// lives at that spot.
//
// Counted over `siteKey`, not over segment ids. See the field's own comment for
// why that distinction is the whole rule: segment ids split at every junction,
// so counting them turns one street into a quorum on its own.
const MIN_REVISIT_SITES = 2;

// How far the fitted rate may disagree with the ride's longest observation,
// as a fraction of that observation on top of MIN_MEANINGFUL_RISE_M.
//
// This is the second half of the bound on defect 1. Each pair carries a leak of
// a few tenths of a metre over its own gap, so it implies a rate error of
// leak/gap; letting a short pair set the slope for a long window multiplies that
// error by the ratio between them. Unbounded, three 31-minute observations at 0,
// 100 and 209 minutes produced a four-hour ramp and turned 1.6m rises into a
// 12.39m correction.
//
// Expressed as a disagreement in metres rather than a ratio of times, because
// metres are what the leak is measured in and what the correction is applied in.
// See the check itself in fitDriftRate for why the ratio version was wrong.
const MAX_CONTRADICTION_FRACTION = 0.5;

// How close to the longest gap an observation has to be to join the veto above.
// Ninety-five per cent, so a loop ridden twice -- which produces a row of pairs
// with gaps differing by the seconds it took to cross each street -- is treated
// as the several observations of the same stretch that it is, rather than having
// one of them arbitrarily crowned.
const LONGEST_OBSERVATION_TOLERANCE = 0.95;

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
  // Distinct places backing the estimate, and by how many metres the fitted rate
  // disagrees with the ride's longest single observation. Both are gates above;
  // both are reported because the eval needs to see how close to the gates the
  // real archive sits rather than only which side of them it fell.
  sites: number;
  contradictionM: number;
}

// The longest stretch of time that the observations actually cover, with no
// gaps, together with every observation lying inside it.
//
// This is defect 1's fix, and the distinction it turns on is narrow enough to
// state twice. `fitDriftRate` used to take the union of the pair intervals --
// min of the starts to max of the ends -- and call that the measured window.
// A union is not a cover: three observations at 0-31, 100-131 and 209-240
// minutes have a union of 0-240 and cover 93 minutes of it. The ramp was then
// drawn across 147 minutes nobody watched, and the file's own comment claiming
// it was "linear only between the first and last moment the drift was actually
// observed" was false for exactly the disjoint case that does the damage.
//
// Merging overlapping and abutting intervals and keeping the largest resulting
// block makes that comment true. A block is gap-free by construction, so its
// length can never exceed the total time observed.
//
// Ties go to the longer block, so a ride whose evidence splits evenly keeps the
// stretch it can say the most about.
export function largestCoveredBlock(
  pairs: Revisit[],
): { fromMs: number; toMs: number; members: Revisit[] } | null {
  if (pairs.length === 0) return null;
  const sorted = [...pairs].sort((a, b) => a.earlyAtMs - b.earlyAtMs);

  let best: { fromMs: number; toMs: number; members: Revisit[] } | null = null;
  let fromMs = sorted[0].earlyAtMs;
  let toMs = sorted[0].lateAtMs;
  let members: Revisit[] = [sorted[0]];

  const keepIfBest = () => {
    const better =
      best == null ||
      members.length > best.members.length ||
      (members.length === best.members.length && toMs - fromMs > best.toMs - best.fromMs);
    if (better) best = { fromMs, toMs, members: [...members] };
  };

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    // `<=` so abutting observations join: a pass at t2 ending one interval and
    // starting the next leaves no unobserved instant between them.
    if (r.earlyAtMs <= toMs) {
      toMs = Math.max(toMs, r.lateAtMs);
      members.push(r);
    } else {
      keepIfBest();
      fromMs = r.earlyAtMs;
      toMs = r.lateAtMs;
      members = [r];
    }
  }
  keepIfBest();
  return best;
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

  // Everything from here on is judged on the observations inside one gap-free
  // block, not on the whole set. A pair outside the block is real evidence about
  // its own stretch of time and no evidence at all about this one, so it must
  // not vote on the rate, the sign, or the quorum.
  const block = largestCoveredBlock(usable);
  if (block == null) return null;
  const members = block.members;
  if (members.length < MIN_REVISIT_PAIRS) return null;

  const sites = new Set(members.map((r) => r.siteKey)).size;
  if (sites < MIN_REVISIT_SITES) return null;

  // The median of the per-pair rates rather than the mean, so one bucket that
  // caught a bad fix cannot set the slope for the whole ride.
  const rates = members.map((r) => r.riseM / ((r.lateAtMs - r.earlyAtMs) / MS_PER_HOUR));
  const rateMPerH = median(rates);
  if (!finite(rateMPerH) || rateMPerH === 0) return null;
  if (Math.abs(rateMPerH) > MAX_DRIFT_RATE_M_PER_H) return null;

  // **Does the ramp contradict the longest thing this ride actually watched?**
  //
  // The median treats a thirty-minute observation and a ninety-minute one as
  // equal votes, so three pairs can outvote the single pair that covers the
  // whole window: rises of 1m over [0,90], [0,30] and [20,50] give a median rate
  // of 2 m/h, and the ramp then claims 3m across a stretch the ride watched
  // end to end and measured at 1m. Nothing else here notices, because the pairs
  // agree on sign, clear the floor, and sit inside every cap.
  //
  // So the longest observation gets a veto. It is the pair with the most direct
  // claim on the window, and if the fitted rate disagrees with what it saw by
  // more than the leaks can explain, the disagreement is the finding and the
  // ride keeps its single number.
  //
  // The allowance is a metre plus half of what was seen: the metre is
  // MIN_MEANINGFUL_RISE_M, below which nothing here can be told from noise
  // anyway, and the fraction keeps the test from tightening without limit on
  // rides that really did move a long way.
  //
  // This replaces a cap on the ratio of window length to shortest observation.
  // That cap punished the best evidence there is: four abutting forty-minute
  // observations tile a hundred and sixty minutes with no unwatched instant, and
  // it refused them while accepting three of the same. Adding evidence took the
  // feature away. A tiled chain contradicts nothing and passes here at any
  // length, while a short pair setting the slope for a long window is refused
  // for the reason it should be -- not because of when it was measured, but
  // because the ride's own best observation says otherwise.
  // The longest observations, plural, and the median of what they saw.
  //
  // Taking the single longest makes the gate depend on input order whenever two
  // pairs tie, which on real rides is common -- a loop ridden twice produces a
  // row of pairs with near-identical gaps. Worse, it let one outlier among the
  // ties decide: six pairs of equal length, four agreeing and two not, were
  // refused or accepted purely on which one `reduce` happened to reach first.
  //
  // So the veto is held by everything within LONGEST_OBSERVATION_TOLERANCE of
  // the longest gap, and it speaks with their median rise -- the same robust
  // statistic used for the rate, for the same reason.
  const gapOf = (r: Revisit) => r.lateAtMs - r.earlyAtMs;
  const longestGapMs = Math.max(...members.map(gapOf));
  const longest = members.filter(
    (r) => gapOf(r) >= longestGapMs * LONGEST_OBSERVATION_TOLERANCE,
  );
  const observedRiseM = median(longest.map((r) => r.riseM));
  const predictedRiseM = (rateMPerH * longestGapMs) / MS_PER_HOUR;
  const contradictionM = Math.abs(predictedRiseM - observedRiseM);
  const allowedM = MIN_MEANINGFUL_RISE_M + Math.abs(observedRiseM) * MAX_CONTRADICTION_FRACTION;
  if (!finite(contradictionM) || contradictionM > allowedM) return null;

  // Is the movement bigger than the leaks? Judged on the rises themselves, not
  // on the rate, because a small rise over a short gap implies a large rate.
  if (median(members.map((r) => Math.abs(r.riseM))) < MIN_MEANINGFUL_RISE_M) return null;

  // Do the pairs agree on direction?
  const agreeing = members.filter((r) => Math.sign(r.riseM) === Math.sign(rateMPerH)).length;
  if (agreeing / members.length < MIN_SIGN_AGREEMENT) return null;

  return {
    rateMPerH,
    fromMs: block.fromMs,
    toMs: block.toMs,
    pairs: members.length,
    sites,
    contradictionM,
  };
}

export interface FitOptions {
  // **Off by default, and that is the shipped behaviour.**
  //
  // Measured against the live archive, the ramp makes every ride it touches
  // worse: self-consistency 1.28m -> 1.73m, cross-ride 2.62m -> 3.26m, terrain
  // shape 2.40m -> 2.42m, 31 comparisons improved against 74 worsened. A
  // verdict that lives only in a commit message is not a verdict -- the file
  // has to refuse, or the next ride saved gets the regression regardless of
  // what anyone wrote down.
  //
  // It defaults off rather than being deleted because the measurement is what
  // is wrong with the feature, not the code, and the eval needs this exact path
  // to keep measuring it. Turning it on is one argument, and doing so without
  // rerunning `npm run eval:anchor` is how the first version of this shipped.
  allowRamp?: boolean;
}

export function fitAnchor(
  points: AnchorPoint[],
  revisits: Revisit[] = [],
  { allowRamp = false }: FitOptions = {},
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
      revisitsUsed: 0,
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
    revisits: revisits.length,
    revisitsUsed: drift.pairs,
  };
}
