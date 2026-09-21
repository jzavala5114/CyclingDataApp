// The measuring half of `scripts/evalAnchorDrift.ts`, extracted so it can be
// tested.
//
// Everything here was inline in that script, closing over a module-level
// `heldOutKeys` map, below a top-level `await` against the database. That made
// the three measures, the untouched-bucket proof and the verdict rule
// unreachable from a test: importing the module ran the eval. So the one part
// of this project that decides whether a change is safe was the only part with
// no gate tests of its own, and the fourth round of review found three
// separate "a check that cannot fail, reported as a check that passed" defects
// living in exactly that blind spot.
//
// The split is: this file takes observations and returns numbers and verdicts,
// the script loads rides, fits anchors and prints. `heldOutKeys` is a parameter
// here, never a module global, which is what lets a test construct a population
// and assert on the answer.

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
  //
  // Carried so the eval can ask a question neither of its original measures
  // could. Self-consistency and cross-ride agreement are both measures of the
  // archive agreeing with itself, and a correction that tilts a ride can improve
  // both while moving the ride away from the ground: the two passes still match
  // each other, and every ride tilts the same way.
  demM: number | null;
}

// "segmentId|direction|distanceM" -> every observation of that bucket.
export type Observations = Map<string, Observation[]>;

// session -> the bucket keys withheld from that session's drift fit.
export type HeldOutKeys = Map<number, Set<string>>;

export const MEASURES = ["self-consistency", "cross-ride", "terrain shape"] as const;
export type MeasureName = (typeof MEASURES)[number];

// Two passes must be at least this far apart to count as a revisit.
//
// **Raised from 300s, which was the eval disagreeing with the fit.** The
// barometer argument for 300s is sound on its own -- two passes five minutes
// apart really are one traversal seen twice -- but it is the wrong question.
// `anchorFit.MIN_REVISIT_GAP_S` is 1800, so a five-minute pair is one the fit
// will never believe, and the ramp's effect across it is rate x 5min: a few
// tenths of a metre at any rate the fit accepts. Those near-immovable
// comparisons were sitting in the median that decides the verdict, diluting it
// towards "nothing moved" -- the same dilution the treated scope exists to
// remove, arriving through the gap threshold instead of the scope filter.
//
// **Its own literal, NOT imported from anchorFit.ts.** Same rule the eval's
// `previousAnchor` control follows and for the same reason: a threshold that
// tracks the module under test moves silently when that module moves.
// `evalMeasures.test.ts` asserts this equals the fit's constant, so a
// divergence fails a test rather than quietly changing what is measured.
export const MIN_REVISIT_GAP_S = 1800;

// From anchorFit.ts, same rule: our own literal, cross-checked by a test.
const MAX_TOTAL_DRIFT_M = 15;

export interface Summary {
  n: number;
  // Values that were not finite. Stats below are computed over the rest.
  //
  // **Never fold these into the statistics.** `mean` over a set containing one
  // NaN is NaN, and every comparison against NaN is false, so `NaN > threshold`
  // silently switches a gate OFF for the whole measure rather than tripping it.
  // That is history defect 2 -- "a bucket the new code dropped scored as
  // identical because NaN compares false" -- and it is a standing hazard in any
  // file that reduces numbers to a verdict. Counted and gated instead.
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
// Scored only on buckets withheld from that ride's drift fit, so a shrinking
// number is the correction generalising rather than the fit reciting its own
// training data back.
//
// Keyed rather than a bare list, so the same comparison can be found in both the
// before and the after run and the two paired up. Summary statistics alone
// cannot tell "helped everything a little" from "helped most and hurt some",
// and those call for different decisions.
//
// **Scoped per RIDE, not per bucket.** This once admitted the whole bucket if
// ANY ride in it was treated, and then measured every ride in that bucket,
// treated or not. Each untreated ride contributes a pair that cannot move,
// which drags both medians together and makes a real effect look smaller than
// it is. The measure's unit is one ride's own disagreement with itself at one
// bucket, so the unit belongs to a single session and the filter belongs beside
// it.
export function selfDisagreements(
  observations: Observations,
  heldOutKeys: HeldOutKeys,
  only?: Set<number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, list] of observations) {
    const bySession = new Map<number, Observation[]>();
    for (const o of list) {
      const seen = bySession.get(o.sessionId);
      if (seen) seen.push(o);
      else bySession.set(o.sessionId, [o]);
    }
    for (const [sessionId, passes] of bySession) {
      if (only && !only.has(sessionId)) continue;
      if (passes.length < 2) continue;
      // Out of sample only.
      if (!heldOutKeys.get(sessionId)?.has(key)) continue;
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
// **This was the range between per-ride means, and the range is the wrong
// statistic twice over.**
//
// It was blind in the middle. `max - min` does not move when a non-extreme
// contributor moves, so a ride bracketed by two others could be shifted 5m at
// every bucket and this reported the identical number before and after. It was
// also monotone in contributor count, so buckets with more rides dominated the
// distribution for a reason that has nothing to do with the treatment, while
// the value itself was set by exactly two of them however many contributed.
//
// What the map draws is a running mean: `mergeBuckets` in sessionProcessor.ts
// does `elevation_m = (elevation_m * sample_count + new) / (sample_count + 1)`,
// which moves whenever any contributor moves. So the disagreement that matters
// is the spread ABOUT that mean, and mean absolute deviation is that spread in
// metres, sensitive to every contributor rather than to the two extremes.
//
// **This is a DISAGREEMENT measure, not the drawn value, and the difference is
// not cosmetic.** Mean absolute deviation is translation invariant: add the
// same amount to every contributor and it does not move at all. So this is
// blind to precisely the case where the drawn value moves most -- every pass at
// a bucket shifted 15m together leaves this reading an unchanged 6.67m. The
// range it replaced was blind to that too; replacing one spread with another
// fixes blindness in the middle and cannot fix blindness to a shift.
//
// That is tolerable here only because setting the level IS the anchor's job,
// and a ride's absolute level is legitimately allowed to move. What it means is
// that **no measure in this file sees a uniform level change**: self-consistency
// cancels the level between two passes, terrain shape subtracts each ride's own
// median, and this one is translation invariant. If the level is ever the
// question, it needs a fourth measure -- the per-bucket drawn value before
// against after -- and not an adjustment to this one, which would stop
// answering the question it is named for.
//
// **One vote per PASS, not per ride.** The old code collapsed each session to
// its own mean first, on the stated grounds that "a ride that passed three
// times counts once". Production disagrees: `mergeBuckets` is called once per
// run and increments `sample_count` by one each call, so three passes get three
// votes in the drawn value. A measure claiming to model what lands on the map
// has to weight the way the map does. The consequence, stated because it is a
// real cost: this now includes a ride's within-ride spread as well as the
// between-ride spread. That is what the drawn value contains too -- the running
// mean has no idea which ride a run came from.
//
// The `>= 2 distinct sessions` test is what keeps it a CROSS-ride measure. It
// decides inclusion only; once a bucket is in, every pass in it votes.
//
// **Treated scope is per BUCKET here, and it has to be.** The other two
// measures measure something belonging to a single ride, so they filter per
// ride. This one measures a relation among every ride that touched the bucket,
// and that number has no single owner. Narrowing it to treated rides would not
// narrow the scope, it would measure a different quantity.
//
// **Held out, with two honest caveats about what that buys.**
//
// This measure previously had no held-out filter at all, and roughly half its
// comparisons sat on buckets whose revisit rises the drift RATE had been fitted
// to shrink, so a gated measure was partly scoring the fit on its own training
// data with nothing saying so. The filter fixes that much: it drops about half
// the comparisons (2146 -> 1077 on the archive) and the survivors are ones no
// rate fit consumed.
//
// Caveat one: **the per-contributor quantifier is inert today.** `heldOut` in
// evalAnchorDrift.ts is a pure FNV hash of `segmentId|direction|distanceM` and
// takes no session, so for any given key either every contributor held it out
// or none did -- measured over 18,000 keys, zero disagreements, and `every`
// keeps exactly the same comparisons `some` would. It is written as `every`
// because that is what the claim requires, and it becomes load-bearing the day
// the split is made per session, which is the better control. Saying it "costs
// comparisons" would be a cost reported for a check that is currently free.
//
// Caveat two, and the larger one: **this does not make the measure out of
// sample, because the LEVEL is still fit on everything.** `points` in
// evalAnchorDrift.ts is built from every bucket of every qualifying run and
// both modes consume it unfiltered; only the revisit set feeding `fitDriftRate`
// is withheld. Cross-ride is the one measure of the three whose value carries
// the level rather than cancelling it, so filtering which buckets it SCORES
// cannot make the level out of sample. What the filter buys is that the rate is
// out of sample. The level is not, and both modes share that, so it does not
// bias before against after -- but "out of sample" unqualified would be false.
export function crossRideDisagreements(
  observations: Observations,
  heldOutKeys: HeldOutKeys,
  only?: Set<number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, list] of observations) {
    if (only && !list.some((o) => only.has(o.sessionId))) continue;
    const sessions = new Set(list.map((o) => o.sessionId));
    if (sessions.size < 2) continue;
    if (![...sessions].every((s) => heldOutKeys.get(s)?.has(key))) continue;
    const values = list.map((o) => o.elevationM);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    out.set(key, values.reduce((a, v) => a + Math.abs(v - mean), 0) / values.length);
  }
  return out;
}

// How far the ride sits from the terrain model, per held-out bucket.
//
// The only measure here that consults anything outside the archive. Both others
// ask whether the data agrees with itself, which a tilt can satisfy while
// walking away from the ground; this one has an external referent and a tilt
// shows up in it immediately.
//
// The absolute level is not the question -- that is what the anchor sets, and a
// whole-ride offset is legitimate. What matters is that the SHAPE stays put, so
// each ride's own median residual is removed before scoring. What is left is how
// far each bucket sits from terrain relative to the rest of its own ride, which
// a ramp changes and a constant offset cannot.
export function terrainDisagreements(
  observations: Observations,
  heldOutKeys: HeldOutKeys,
  only?: Set<number>,
): Map<string, number> {
  const residualsBySession = new Map<number, Array<{ key: string; residualM: number }>>();
  for (const [key, list] of observations) {
    for (const o of list) {
      if (only && !only.has(o.sessionId)) continue;
      if (o.demM == null) continue;
      if (!heldOutKeys.get(o.sessionId)?.has(key)) continue;
      const seen = residualsBySession.get(o.sessionId);
      const entry = { key: `${key}|${o.sessionId}|${o.atMs}`, residualM: o.elevationM - o.demM };
      if (seen) seen.push(entry);
      else residualsBySession.set(o.sessionId, [entry]);
    }
  }

  const out = new Map<string, number>();
  for (const entries of residualsBySession.values()) {
    const sorted = entries.map((e) => e.residualM).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const level = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    for (const e of entries) out.set(e.key, Math.abs(e.residualM - level));
  }
  return out;
}

export function measure(
  name: MeasureName,
  observations: Observations,
  heldOutKeys: HeldOutKeys,
  only?: Set<number>,
): Map<string, number> {
  switch (name) {
    case "self-consistency":
      return selfDisagreements(observations, heldOutKeys, only);
    case "cross-ride":
      return crossRideDisagreements(observations, heldOutKeys, only);
    case "terrain shape":
      return terrainDisagreements(observations, heldOutKeys, only);
  }
}

// ---------------------------------------------------------------------------
// The untouched-bucket proof
// ---------------------------------------------------------------------------

export interface UntouchedProof {
  checked: number;
  moved: number;
  missing: number;
  // Observation identities present in one mode and not the other, in either
  // direction. Zero by construction today; see `verifyUntouched`.
  structurallyDifferent: number;
  // No untouched bucket existed to check anywhere. The proof certified nothing.
  vacuous: boolean;
  // **Untreated rides the proof never looked at, which is the per-ride form of
  // `vacuous`.** The skip is per BUCKET: any bucket with a treated contributor
  // is skipped whole. So an untreated ride that shares every one of its buckets
  // with a treated ride is never checked -- while some other ride's private
  // buckets keep `checked` well above zero, so `vacuous` stays false and the
  // script prints an affirmative "verified identical: N/N".
  //
  // That ride is then invisible three ways at once: unchecked here, filtered
  // out of the treated-scope measures by `only`, and present only in the
  // whole-archive line, which is printed and never gated. It can be 40m out in
  // `after` and the run exits 0.
  //
  // The premise this proof exists to establish -- "rides the change touched is
  // every comparison that could have moved" -- is a claim about RIDES, so the
  // coverage test has to be per ride too. A count of observations has no owner.
  uncheckedSessions: number[];
}

// Prove that the rides which kept a single number came out bit-for-bit
// identical. If that holds, "rides the change touched" is not a convenient
// subset, it is every comparison that could have moved, and the whole-archive
// figures are that same set plus a fixed unchanged mass.
//
// **`vacuous` is the fix for the defect that made this whole file necessary.**
// Line by line the proof was correct; what it lacked was any assertion that it
// had subjects. When every bucket has at least one treated contributor, every
// bucket is skipped, both counters stay at zero, and the script printed
// `untouched buckets verified identical: 0/0` and exited 0. A reassuring
// 8742/8742 and a vacuous 0/0 were indistinguishable to the gate. The script
// contained the correct doctrine twenty lines above -- "an eval that measured
// nothing does not pass" -- and applied it to the three measures and not to the
// proof that licenses them.
//
// **`structurallyDifferent` replaces a check that could not fail.** The old
// `missing` branch was justified as catching "a bucket the new code dropped
// entirely", and it was unreachable: the observation population is built once
// per session, before the mode loop, without consulting any fit, so both modes
// emit one observation per run and bucket and the identity sets are equal by
// construction. It is kept, and now counts identities missing in EITHER
// direction rather than only in `after`, because the risk it was written for is
// real -- a fitter that changed which runs qualify would break the premise -- it
// simply cannot arise while the population is fit-independent. It is reported
// only when it fires, never as a check that passed.
export function verifyUntouched(
  before: Observations,
  after: Observations,
  treated: Set<number>,
): UntouchedProof {
  const identity = (o: Observation) => `${o.sessionId}|${o.atMs}`;
  let checked = 0;
  let moved = 0;
  let missing = 0;
  let structurallyDifferent = 0;
  // Every untreated ride that appears in `before`, and whether the loop below
  // ever actually looked at one of its observations.
  const untreatedSessions = new Set<number>();
  const coveredSessions = new Set<number>();
  for (const list of before.values()) {
    for (const o of list) if (!treated.has(o.sessionId)) untreatedSessions.add(o.sessionId);
  }

  // The union of keys, not `before`'s alone. The after-only scan used to live
  // inside `for (const [key] of before)`, so a bucket that exists only in
  // `after` was never visited -- and that is the direction that matters, since
  // the risk being guarded is a fitter that makes buckets qualify which did not
  // before. The check advertised "either direction" and could see one.
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const beforeList = before.get(key) ?? [];
    if (beforeList.some((o) => treated.has(o.sessionId))) continue;
    if ((after.get(key) ?? []).some((o) => treated.has(o.sessionId))) continue;
    // Matched on the observation's own identity rather than on position in the
    // list. Both lists are built in the same loop order today, so indexing works
    // by luck; a reordering anywhere upstream would silently start comparing one
    // ride's bucket against another's and still report agreement.
    const afterList = after.get(key) ?? [];
    const afterByIdentity = new Map(afterList.map((o) => [identity(o), o]));
    const beforeIdentities = new Set(beforeList.map(identity));
    for (const o of afterList) {
      if (!beforeIdentities.has(identity(o))) structurallyDifferent += 1;
    }
    for (const beforeObservation of beforeList) {
      checked += 1;
      coveredSessions.add(beforeObservation.sessionId);
      const afterObservation = afterByIdentity.get(identity(beforeObservation));
      // An explicit presence test, because the arithmetic one cannot do it.
      // This read `Math.abs(before - (after?.elevationM ?? NaN)) > 1e-9`, and
      // every comparison against NaN is false -- so a bucket the new code
      // dropped entirely scored as identical and counted towards the proof.
      // The one failure the check existed to catch was the one it could not see.
      if (afterObservation == null) {
        missing += 1;
        moved += 1;
        structurallyDifferent += 1;
        continue;
      }
      const delta = beforeObservation.elevationM - afterObservation.elevationM;
      if (!Number.isFinite(delta) || Math.abs(delta) > 1e-9) moved += 1;
    }
  }

  return {
    checked,
    moved,
    missing,
    structurallyDifferent,
    vacuous: checked === 0,
    uncheckedSessions: [...untreatedSessions].filter((s) => !coveredSessions.has(s)).sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------------------
// Pairing and the verdict
// ---------------------------------------------------------------------------

export interface PairedChange {
  improved: number;
  worsened: number;
  unchanged: number;
  // Comparisons whose change was not a finite number, excluded from every count
  // and statistic above. See `Summary.nonFinite`: one of these used to poison
  // `meanChangeM` and `worstRegressionM` into NaN, switching two of the five
  // gates off for the entire measure, while itself being counted as `worsened`
  // by the sign test's `else` branch -- harm that disables the alarm and then
  // pads the count in the passing direction.
  nonFinite: number;
  medianChangeM: number;
  meanChangeM: number;
  worstRegressionM: number;
}

// Did it help every comparison, or help most and hurt some?
//
// A summary cannot tell those apart and they call for different decisions. A
// median over the whole archive that moves the WRONG way while the treated
// median improves is not sampling noise: if every changed comparison had weakly
// improved, no quantile could rise, because the sorted array would be pointwise
// below the old one. A quantile that rises is proof that individual comparisons
// got worse, and the only honest response is to count them.
export function pairedChange(
  before: Map<string, number>,
  after: Map<string, number>,
): PairedChange {
  const deltas: number[] = [];
  let improved = 0;
  let worsened = 0;
  let unchanged = 0;
  let nonFinite = 0;
  let worstRegressionM = 0;
  for (const [key, b] of before) {
    const a = after.get(key);
    if (a == null) continue;
    const delta = a - b;
    // Ahead of every classification, because `delta < 0` is false for NaN and
    // the `else` below would file it as a regression whose magnitude then
    // poisons `Math.max` into NaN. One such comparison used to disable the mean
    // and worst-regression gates for the whole measure.
    if (!Number.isFinite(delta)) {
      nonFinite += 1;
      continue;
    }
    deltas.push(delta);
    if (Math.abs(delta) <= 1e-9) unchanged += 1;
    else if (delta < 0) improved += 1;
    else {
      worsened += 1;
      worstRegressionM = Math.max(worstRegressionM, delta);
    }
  }
  // **The proper median, averaging the two middle values on an even count.**
  // This was `moved[Math.floor(moved.length / 2)]`, which takes the UPPER of the
  // two middles, so a perfectly balanced set of changes reported a positive
  // number by construction: fifty comparisons worse by 9m against fifty better
  // by 10m printed `median_change_m: 9.00` when the honest answer is -0.50, and
  // the honest answer agrees with the mean. A printed statistic that reads as
  // harm on a distribution that improved is worse than an ungated one -- it
  // invites exactly the override it looks like it should trigger.
  const moved = deltas.filter((d) => Math.abs(d) > 1e-9).sort((a, b) => a - b);
  const mid = Math.floor(moved.length / 2);
  return {
    improved,
    worsened,
    unchanged,
    nonFinite,
    medianChangeM: moved.length === 0
      ? 0
      : moved.length % 2 === 0
        ? (moved[mid - 1] + moved[mid]) / 2
        : moved[mid],
    meanChangeM: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0,
    worstRegressionM,
  };
}

// The largest regression in a single comparison that a legitimate correction
// could possibly produce. Past this the answer is not "the ramp helped less
// than hoped", it is "something is wrong with the fit or with this harness",
// and it has to be visible even when the aggregate looks fine: ten thousand
// comparisons improving 0.5m hide one regressing 300m in every mean and every
// median.
//
// Derived per measure, because the derivation genuinely differs:
//
//   self-consistency  Two passes of ONE ride at one bucket. `before` applies a
//                     constant, which cancels between the two passes entirely.
//                     `after` applies a ramp, so the value changes by exactly
//                     |offsetAt(late) - offsetAt(early)|, which is at most the
//                     ride's total drift, which `fitDriftRate` refuses above
//                     MAX_TOTAL_DRIFT_M. A derived bound.
//
//   terrain shape     One observation's residual against its own ride's median
//                     residual. The ramp moves the residual by offsetAt(t) and
//                     the median by the median of those, so the value changes by
//                     at most |offsetAt(t) - median(offsetAt)|, again inside the
//                     ride's total drift. A derived bound.
//
//   cross-ride        NOT derived, and labelled so. The statistic spans rides
//                     whose constant and ramped levels need not agree, so no
//                     bound follows from MAX_TOTAL_DRIFT_M alone. Two ramped
//                     rides is the shape that moves it most, so twice the total
//                     drift is the judgement -- a bound that fires on the
//                     impossible, not on the marginal. Ordinary harm is what the
//                     mean and count gates below are for.
export const MAX_DEFENSIBLE_REGRESSION_M: Record<MeasureName, number> = {
  "self-consistency": MAX_TOTAL_DRIFT_M,
  "terrain shape": MAX_TOTAL_DRIFT_M,
  "cross-ride": 2 * MAX_TOTAL_DRIFT_M,
};

//   PASS          measured, and every gate held
//   FAIL          measured, and something got worse
//   INCONCLUSIVE  measured nothing that could move, so there is no verdict
//   NONE          no comparisons at all
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "NONE";

export interface Judgement {
  verdict: Verdict;
  // Why, in the caller's own words, one line per gate that fired. Empty on a
  // PASS.
  reasons: string[];
}

// **Four gates, because one was three short.**
//
// This was `after.median <= before.median ? "PASS" : "FAIL"` and nothing else,
// while `mean`, `p90`, `worst`, `worsened` and `worst_regression_m` were all
// computed, all printed, and none consulted. Six comparisons improving 0.10m
// against five regressing 40m exited 0. The script's own comment named that
// exact failure mode and called out the wrong response -- "the only honest
// response is to count them rather than to wave at the p90 and move on" -- and
// then the script counted them, printed the count, and waved at the median.
//
// Each gate names a failure the others cannot see:
//
//   median   the typical comparison must not get worse. Insensitive to
//            magnitude, which is why it cannot be the only one.
//   mean     total error must go down. This is the gate that catches "helped
//            many a little, hurt a few enormously"; it needs no threshold
//            because the question is simply which way the sum moved.
//   count    more comparisons must be helped than hurt. Catches a change that
//            hurts most of what it touches while a few large gains hold the
//            median and the mean down.
//   worst    no single comparison may move further than a legitimate correction
//            could move it. Catches the impossible movement that an aggregate
//            drowns.
//
// The INCONCLUSIVE rule above them is the third critical finding: asking
// `before.n === 0 && after.n === 0` asks "were there comparisons?", not "could
// any comparison have moved?". A ramp shifting every observation of a treated
// ride by 5m leaves self-consistency and terrain shape identical by
// construction -- both cancel a constant -- so they reported improved 0,
// worsened 0, unchanged 11, and `after.median <= before.median` was true, and
// it read as a PASS. `n > 0` was satisfied while the measure had zero power.
// That is the same "could not have detected harm" the script already wrote
// exit 2 for, and the data to detect it was already sitting in `paired`.
// Which population is being judged. The zero-power rule below depends on it,
// because "most comparisons could not move" means opposite things in the two:
// in the treated scope it is a failure of power, and in the whole archive it is
// the expected shape -- that scope is dominated by rides the change never
// touched, whose before and after are identical by construction, and the
// untouched-bucket proof exists precisely to establish that fixed unchanged
// mass. Applying the ratio there would report the design as a defect on every
// run.
export type Scope = "treated" | "whole archive";

export function judgeMeasure(
  name: MeasureName,
  before: Summary,
  after: Summary,
  paired: PairedChange,
  scope: Scope = "treated",
): Judgement {
  if (before.n === 0 && after.n === 0) {
    return {
      verdict: "NONE",
      reasons: ["no comparisons -- the fit treated no rides, so there is nothing to judge"],
    };
  }

  // A value the harness cannot interpret is a defect in the harness, and it is
  // never a pass. Checked before every other gate because it is what disables
  // them: NaN silences a `>` comparison rather than tripping it.
  const nonFinite = before.nonFinite + after.nonFinite + paired.nonFinite;
  if (nonFinite > 0) {
    return {
      verdict: "FAIL",
      reasons: [
        `${nonFinite} non-finite value(s) in this measure -- a comparison the harness ` +
          `cannot read must not be scored, and must never silence a gate`,
      ],
    };
  }

  // **Zero power is a ratio, not an all-or-nothing.** This asked
  // `improved === 0 && worsened === 0`, so one comparison in ten thousand moving
  // by a tenth of a millimetre licensed a verdict over the 9,999 that could not
  // move -- a quorum of one, which is the family this feature keeps being
  // rejected for. `unchanged > improved + worsened` says: most of what was
  // measured could not respond, so the measure has less power than its
  // comparison count suggests. It reduces to the old rule when nothing moved at
  // all, and on the current archive it does not fire, because every treated
  // comparison moves.
  const moved = paired.improved + paired.worsened;
  const frozen = scope === "treated" ? paired.unchanged > moved : false;
  if (moved === 0 || frozen) {
    return {
      verdict: "INCONCLUSIVE",
      reasons: [
        moved === 0
          ? `zero power: all ${paired.unchanged} comparisons came out identical, so this ` +
            `measure could not have detected harm of any size`
          : `zero power: ${paired.unchanged} of ${paired.unchanged + moved} comparisons came ` +
            `out identical, so this measure could not have detected harm in most of what ` +
            `it counted`,
      ],
    };
  }

  const reasons: string[] = [];
  if (after.median > before.median) {
    reasons.push(
      `median rose ${before.median.toFixed(2)}m -> ${after.median.toFixed(2)}m`,
    );
  }
  if (after.mean > before.mean) {
    reasons.push(
      `mean rose ${before.mean.toFixed(2)}m -> ${after.mean.toFixed(2)}m ` +
        `(total error went up, whatever the median did)`,
    );
  }
  if (paired.worsened > paired.improved) {
    reasons.push(
      `${paired.worsened} comparisons got worse against ${paired.improved} better`,
    );
  }
  // **`medianChangeM` is deliberately NOT a gate, and that is a decision, not
  // an oversight.**
  //
  // It was flagged as the F2 shape surviving one column over -- computed,
  // printed, never read -- on a case where fifty comparisons worsen by 9m
  // against fifty improving by 10m, which ties the count gate and prints
  // `median_change_m: 9.00`. The number was the defect: the upper-median
  // convention put it on the positive side by construction. With the proper
  // median it reads -0.50 on that population, agreeing with the mean, and the
  // PASS is correct -- total error fell by 50m and the counts tied.
  //
  // Gating it after that fix adds nothing the other gates miss. The mean
  // already asks the magnitude question over every comparison, and the count
  // already asks the population question; a median of signed changes fires only
  // where one of those two has fired first. A fifth gate that cannot fire alone
  // is a gate in name only, which is the shape this file exists to remove.
  // It stays printed, as a diagnostic that should agree with the mean -- when
  // the two disagree in sign, read the distribution before believing either.
  const bound = MAX_DEFENSIBLE_REGRESSION_M[name];
  if (paired.worstRegressionM > bound) {
    reasons.push(
      `worst single regression ${paired.worstRegressionM.toFixed(2)}m exceeds the ` +
        `${bound}m a legitimate correction could produce`,
    );
  }

  return { verdict: reasons.length > 0 ? "FAIL" : "PASS", reasons };
}
