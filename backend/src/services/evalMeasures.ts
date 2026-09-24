// Three ways of asking whether the elevation model agrees with reality.
//
// These were built to judge the sliding drift anchor, as a before/after
// comparison with gates and a verdict. That feature was removed on 2026-09-23
// after four reviews (see `anchorFit.ts` and `context/session.md`), and the
// comparison machinery went with it: there is no second mode to compare
// against any more, so the untouched-bucket proof, the pairing and the five
// gates are all gone.
//
// **`heldOutKeys` went too, and that changes the numbers, not just the code.**
// It confined `selfDisagreements` and `crossRideDisagreements` to buckets
// withheld from the drift-rate fit, so the measures would be scored out of
// sample. With no fit there is nothing to withhold from, so both now score
// every bucket -- which roughly DOUBLES their comparison counts (cross-ride was
// 2146 before the filter and 1077 after it, on this archive). A number printed
// by the old eval and a number printed by this one are not comparable. Do not
// put them in the same table.
//
// **The measures themselves survive, because they were never about the ramp.**
// They measure the model, and the model is still here. `terrainDisagreements`
// in particular is the only quality number this project has that consults
// anything outside its own archive, which is exactly why a review asked for it
// to be kept.
//
// What this file is now: pure functions from observations to numbers, with no
// database and no side effects, so `evalModelQuality.ts` can load rides and
// these can be tested. That separation is the one part of the old design worth
// keeping verbatim -- while these lived inline under a top-level `await`
// against the production database, importing them ran the eval, and they were
// the only untested code in the project.

// One pass over one bucket, as one ride recorded it.
//
// One entry per (run, bucket): a ride that passed the same bucket three times
// contributes three observations, and that is deliberate -- see
// `crossRideDisagreements`, where matching production's per-run weighting is
// the whole point.
export interface Observation {
  sessionId: number;
  atMs: number;
  elevationM: number;
  // What the terrain model says this spot is, or null where it has no value.
  demM: number | null;
}

// "segmentId|direction|distanceM" -> every observation of that bucket.
export type Observations = Map<string, Observation[]>;

// "terrain shape" was the old name, from when this removed each ride's level
// and judged only the shape. It no longer does -- see `terrainDisagreements`.
export const MEASURES = ["self-consistency", "cross-ride", "terrain"] as const;
export type MeasureName = (typeof MEASURES)[number];

// Two passes must be at least this far apart to count as a revisit.
//
// **Back to 300s, and the reason is worth recording because it reversed.** This
// was 300s on a barometer argument -- two passes five minutes apart are really
// one traversal seen twice, and the sensor has had no time to move between
// them. A review then raised it to 1800s, correctly, because the drift fit only
// believed revisits half an hour apart and admitting shorter ones diluted the
// median that decided the verdict.
//
// That fit no longer exists, so there is nothing left to align with, and the
// original argument is the governing one again. A five-minute gap is a real
// revisit for the question this measure actually asks: does the ride agree with
// itself at this spot? Nothing is being fitted, so nothing can be diluted.
//
// **What the revert makes matter more, stated because it is not obvious.** The
// timestamp on each observation is the run's MIDPOINT, and every bucket in a
// run carries that same value -- so this threshold compares run midpoints, not
// the moments the rider was actually at that bucket. The error is bounded by
// half the sum of the two runs' durations, which at 1800s was a few percent of
// the threshold and at 300s is a much larger share of it. The approximation did
// not change; the tolerance for it shrank six-fold.
export const MIN_REVISIT_GAP_S = 300;

export interface Summary {
  n: number;
  // Values that were not finite. Stats below are computed over the rest.
  //
  // **Never fold these into the statistics.** A mean over a set containing one
  // NaN is NaN, and every comparison against NaN is false, so a NaN silently
  // switches off any threshold it is compared against rather than tripping it.
  // Counted separately so it can be reported instead of disappearing.
  nonFinite: number;
  median: number;
  mean: number;
  p90: number;
  worst: number;
}

export function summarise(values: number[]): Summary {
  const finite = values.filter((v) => Number.isFinite(v));
  const nonFinite = values.length - finite.length;
  if (finite.length === 0) {
    return { n: values.length, nonFinite, median: NaN, mean: NaN, p90: NaN, worst: NaN };
  }
  const sorted = finite.sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n: values.length,
    nonFinite,
    median: at(0.5),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p90: at(0.9),
    worst: sorted[sorted.length - 1],
  };
}

// One ride, one bucket, two passes far enough apart in time to be a revisit.
//
// The rider cannot have changed the height of the ground between them, so any
// difference is the ride disagreeing with itself. The closest thing to a ground
// truth here, because it needs no second ride and no terrain model.
//
// Keyed by bucket AND session, because the unit is one ride's disagreement with
// itself at one place. Two rides that both revisit the same bucket are two
// separate readings, not one.
export function selfDisagreements(observations: Observations): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, list] of observations) {
    const bySession = new Map<number, Observation[]>();
    for (const o of list) {
      const seen = bySession.get(o.sessionId);
      if (seen) seen.push(o);
      else bySession.set(o.sessionId, [o]);
    }
    for (const [sessionId, passes] of bySession) {
      // **Redundant, and kept deliberately.** A single pass has first === last,
      // so its gap is exactly 0 and the MIN_REVISIT_GAP_S check below rejects it
      // anyway -- no refusal is ever attributable to this line alone, and a
      // mutation harness correctly reports removing it as behaviour-preserving.
      // It stays because the domination is a consequence of the OTHER check: set
      // MIN_REVISIT_GAP_S to 0 and this becomes load-bearing the same day, which
      // is the wrong day to discover it was deleted.
      if (passes.length < 2) continue;
      const sorted = [...passes].sort((a, b) => a.atMs - b.atMs);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if ((last.atMs - first.atMs) / 1000 < MIN_REVISIT_GAP_S) continue;
      out.set(`${key}|${sessionId}`, Math.abs(last.elevationM - first.elevationM));
    }
  }
  return out;
}

// One bucket, several rides: how far the passes feeding it sit from the value
// the map actually draws.
//
// **Mean absolute deviation, not the range between per-ride means.** The range
// was blind in the middle -- it does not move when a non-extreme contributor
// moves -- and it was monotone in contributor count, so buckets with more rides
// dominated the distribution for a reason unrelated to quality. What the map
// draws is a running mean, which moves whenever any contributor moves, so the
// spread ABOUT that mean is the honest statistic.
//
// **One vote per PASS, not per ride**, because `mergeBuckets` is called once
// per run and increments `sample_count` by one each call. A ride that passed
// three times gets three votes in the drawn value, so a measure claiming to
// model what lands on the map has to weight the way the map does. The
// consequence, stated because it is real: this includes within-ride spread as
// well as between-ride spread, exactly as the drawn value does. The
// two-distinct-sessions test below is what keeps it a CROSS-ride measure; it
// decides inclusion only, and once a bucket is in, every pass in it votes.
//
// **Translation invariant, so it is blind to a uniform shift.** Add the same
// amount to every contributor and this does not move, which is the case where
// the drawn value moves most. That is tolerable because setting a ride's level
// is the anchor's job, and it means no measure in this file sees a uniform
// level change -- self-consistency cancels the level between two passes, terrain
// shape subtracts each ride's own median, and this one is a spread. If the
// level ever becomes the question it needs a fourth measure, not an edit here.
export function crossRideDisagreements(observations: Observations): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, list] of observations) {
    if (new Set(list.map((o) => o.sessionId)).size < 2) continue;
    const values = list.map((o) => o.elevationM);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    out.set(key, values.reduce((a, v) => a + Math.abs(v - mean), 0) / values.length);
  }
  return out;
}

// How far the model sits from the terrain model, per bucket, with production's
// own anchor already applied by the caller.
//
// The only measure here that consults anything outside the archive. The other
// two ask whether the data agrees with itself, which a systematically wrong
// ride can satisfy perfectly; this one has an external referent.
//
// **It used to remove each ride's own median residual before scoring, and that
// was wrong in the one direction that mattered.** The stated reason was that
// the absolute level is the anchor's job, so only the SHAPE should be judged.
// But the caller has already subtracted the anchor production applied, so for
// an anchored ride the residuals are centred on zero and removing their median
// again does nothing -- verified: the level came out 0.000000000000 for every
// anchored ride tested.
//
// The rides it did affect were the ones `fitAnchor` REFUSED. A ride sitting 80m
// off the terrain is past MAX_PLAUSIBLE_OFFSET_M, so production merges it
// unanchored and the map draws it 80m out -- and this measure quietly anchored
// it anyway, with the very offset the guard exists to reject, and reported
// 1.00m. The one measure with an external referent was blind to exactly the
// failure the external referent was brought in for.
//
// So: no second level. Score what the model actually holds. For an anchored
// ride that is shape deviation, because the level is already zero; for an
// unanchored one the level error is genuinely in the model, and it shows.
export function terrainDisagreements(observations: Observations): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, list] of observations) {
    for (const o of list) {
      if (o.demM == null) continue;
      out.set(`${key}|${o.sessionId}|${o.atMs}`, Math.abs(o.elevationM - o.demM));
    }
  }
  return out;
}

export function measure(name: MeasureName, observations: Observations): Map<string, number> {
  switch (name) {
    case "self-consistency":
      return selfDisagreements(observations);
    case "cross-ride":
      return crossRideDisagreements(observations);
    case "terrain":
      return terrainDisagreements(observations);
  }
}
