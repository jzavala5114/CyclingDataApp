import * as turf from "@turf/turf";
import type { SessionSample } from "../types/index.js";

// A fix whose height disagrees with its neighbours by more than this, as a
// gradient over the ground between them, is not describing terrain. The
// steepest rideable trail here is well under 40%, and the archive's own
// distribution backs that up: 25 of 28 sessions never exceed 50% at all, and
// across every ride only 178 of 10,820 steps (1.6%) pass 100%. Those that do
// are unmistakable -- 1971.0 -> 1984.1 -> 1962.9m across 4.4m of ground, a 13m
// climb and a 21m drop in the length of a bike.
//
// Set at 100 rather than 40 deliberately. This exists to remove the physically
// impossible, not to police steepness: a genuine 45% pitch on a rocky descent
// must survive, and the EMA below plus bucket averaging handle ordinary noise.
export const MAX_PLAUSIBLE_GRADE_PCT = 100;

// Below this the ground distance is mostly GPS jitter, and dividing by it turns
// a normal reading into an infinite gradient.
const MIN_STEP_M = 1;

// How much each raw reading contributes vs. the running average -- lower is
// smoother.
//
// **This was 0.3 in a single forward pass, and that filter had a lag.** An
// exponential moving average is causal: it can only ever average the past, so
// the height it reports for a spot is really the height of ground a little way
// BACK along the direction of travel. At alpha 0.3 that lag is exactly 2.333
// samples, and it is not a rounding error, it is a bias.
//
// The lag is measured in samples, so what it costs depends on how much ground
// a sample covers -- and that is not constant. Measured across 17,092 steps of
// the archive, fixes arrive on a near-fixed ~2 second interval (2.04s slow,
// 1.85s fast), so spacing tracks speed: a median of 4.77m under 3 m/s against
// 11.83m at 6 m/s and above. The lag in ground distance therefore swings from
// about 11m to about 27m with the rider's speed.
//
// On a slope that turns into an elevation error that depends on how fast you
// were going. Ride the same hill fast and then slowly and the two passes
// disagree by roughly (lag difference) x gradient -- about 0.96m on a 6% grade,
// 1.9m on 12% -- with no weather, no drift and no GPS error involved. It is
// systematic rather than random, so averaging more passes does not remove it,
// and it is signed by gradient, so it is worst exactly where the model is most
// interesting.
//
// **The fix is to run the filter forwards and then backwards over its own
// output.** The second pass carries the mirror image of the first pass's lag,
// so the two cancel: the combined response is symmetric about each sample and
// the lag is exactly zero rather than merely small. (Standard zero-phase or
// "filtfilt" filtering. Verified below by feeding it a ramp.)
//
// Two passes also smooth twice, which would quietly trade a lag bug for
// over-smoothing and flatten short real features. So the coefficient is
// re-tuned to hold the noise damping exactly where it was. For white input the
// single pass has noise gain alpha/(2-alpha) = 0.1765 at 0.3; the two-pass
// filter's effective response is the autocorrelation of the one-pass response,
// g[n] = (a/(2-a))(1-a)^|n|, with noise gain a(1+(1-a)^2)/(2-a)^3. Setting
// those equal gives 0.485, confirmed against a 200,000-sample simulation.
//
// So: same noise reduction as before, no lag. The one thing given up is that
// this is no longer causal -- it needs the whole ride in hand. That costs
// nothing here because it already runs over a complete array offline, but it
// could not be used to smooth a live reading as it arrives.
const EMA_ALPHA = 0.485;

// How far the series is extended past each end before filtering.
//
// Without this the two passes treat the ends differently -- the forward pass
// starts from a raw reading, the backward pass starts from an already-filtered
// one -- so the filter is only truly zero-phase in the middle. Measured, that
// left the first and last few fixes of a ride out by as much as a metre, on
// exactly the fixes that sit at block ends where coverage is already thin.
//
// Each pass forgets a sample's influence by a factor of (1-alpha) per step, so
// 24 samples of run-up decays an edge transient by 0.515^24, around 1e-7 m.
// That is the padding paying for itself and then stopping.
const EDGE_PAD_SAMPLES = 24;

// Phone barometers are noisy at the single-reading level, and a single noisy
// reading can swing the slope computed over one bucket by several percent (see
// elevationAggregator.ts). This damps that noise before it reaches the
// per-segment elevation model, without displacing it along the road. Requires
// `samples` to already be ordered by recordedAt.
export function smoothElevations(samples: SessionSample[]): SessionSample[] {
  if (samples.length === 0) return [];

  const raw = samples.map((s) => s.elevationM);
  const pad = Math.min(raw.length - 1, EDGE_PAD_SAMPLES);
  const padded: number[] = [];
  // Reflected about the endpoint VALUE, not merely mirrored. A plain mirror
  // (x[1], x[2]...) makes the series turn around at the boundary, which reads
  // as flat ground and drags the first fixes of a ride towards level. Rides
  // routinely start and end mid-slope -- pushing off down a hill is the normal
  // case -- so the reflection continues the local gradient instead:
  // 2*x[0] - x[k] is the existing trend carried backwards past the start.
  for (let k = pad; k >= 1; k--) padded.push(2 * raw[0] - raw[k]);
  for (const value of raw) padded.push(value);
  for (let k = 1; k <= pad; k++) padded.push(2 * raw[raw.length - 1] - raw[raw.length - 1 - k]);

  const forward: number[] = new Array(padded.length);
  let ema = padded[0];
  forward[0] = ema;
  for (let i = 1; i < padded.length; i++) {
    ema = EMA_ALPHA * padded[i] + (1 - EMA_ALPHA) * ema;
    forward[i] = ema;
  }

  // Backward over the forward pass's output, never over the raw input: it is
  // running the same filter the other way round that mirrors the lag and
  // cancels it. Filtering the raw samples again and averaging the two would
  // leave both lags in place, pointing opposite ways.
  const smoothed: number[] = new Array(padded.length);
  let back = forward[forward.length - 1];
  smoothed[smoothed.length - 1] = back;
  for (let i = padded.length - 2; i >= 0; i--) {
    back = EMA_ALPHA * forward[i] + (1 - EMA_ALPHA) * back;
    smoothed[i] = back;
  }

  return samples.map((sample, i) => ({ ...sample, elevationM: smoothed[pad + i] }));
}

// Drops fixes whose height cannot be reconciled with the fixes either side.
//
// This replaces judging a whole ride by its median roughness, which was the
// wrong instrument twice over. Its stated purpose -- detecting rides recorded
// on GPS altitude -- does not survive measurement, because GPS altitude
// quantises and holds its value and so reads *smoother* than a working
// barometer. And a median cannot see a spike: it excluded sessions 46 and 50,
// with 3.8% and 3.2% of their steps physically impossible, while keeping
// session 54 at 6.6%. Judging each fix on its own merits catches the bad ones
// wherever they are and costs nothing everywhere else.
//
// A spike shows up as a disagreement with the straight line between its
// neighbours, not with either one alone -- comparing only to the previous fix
// blames both ends of a step and cannot tell which of the two moved.
//
// The whole sample is dropped rather than just its height. A fix carrying an
// impossible altitude usually got it from a multipath burst that moved its
// position too, and its neighbours still bracket the ground it covered, so the
// run's span and coverage survive intact.
export function rejectElevationSpikes(samples: SessionSample[]): {
  kept: SessionSample[];
  rejected: SessionSample[];
} {
  if (samples.length < 3) return { kept: samples, rejected: [] };

  const kept: SessionSample[] = [samples[0]];
  const rejected: SessionSample[] = [];

  for (let i = 1; i < samples.length - 1; i++) {
    // Compared against the last fix *kept*, so a run of consecutive spikes
    // cannot drag the reference along with it.
    const before = kept[kept.length - 1];
    const after = samples[i + 1];
    const sample = samples[i];

    const toBefore = turf.distance([before.lon, before.lat], [sample.lon, sample.lat], { units: "meters" });
    const toAfter = turf.distance([sample.lon, sample.lat], [after.lon, after.lat], { units: "meters" });
    const span = toBefore + toAfter;

    if (span < MIN_STEP_M) {
      kept.push(sample);
      continue;
    }

    // Where the fix would sit if the ground ran straight between its
    // neighbours, and how far above or below that it actually claims to be.
    const t = toBefore / span;
    const expected = before.elevationM + (after.elevationM - before.elevationM) * t;
    const deviationM = Math.abs(sample.elevationM - expected);
    // Scaled by the shorter leg: a fix 2m out between neighbours 3m away is a
    // far stronger claim than the same 2m between neighbours 30m away.
    const legM = Math.max(MIN_STEP_M, Math.min(toBefore, toAfter));

    if ((deviationM / legM) * 100 > MAX_PLAUSIBLE_GRADE_PCT) rejected.push(sample);
    else kept.push(sample);
  }

  kept.push(samples[samples.length - 1]);
  return { kept, rejected };
}
