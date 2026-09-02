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

// How much each new raw reading contributes vs. the running average --
// lower is smoother. 0.3 averages over roughly the last ~3 seconds of
// readings at the ~1Hz rate the app polls the barometer/GPS, which lines
// up with BUCKET_SIZE_M in elevationAggregator.ts at typical cycling speed.
const EMA_ALPHA = 0.3;

// Phone barometers are noisy at the single-reading level, and readings
// arrive at only ~1Hz -- a single noisy reading can swing the slope
// computed over one bucket by several percent (see elevationAggregator.ts).
// This applies an exponential moving average over a session's samples, in
// chronological order, before they're matched/bucketed, damping that noise
// before it reaches the per-segment elevation model. Requires `samples` to
// already be ordered by recordedAt.
export function smoothElevations(samples: SessionSample[]): SessionSample[] {
  let ema: number | null = null;
  return samples.map((sample) => {
    ema = ema == null ? sample.elevationM : EMA_ALPHA * sample.elevationM + (1 - EMA_ALPHA) * ema;
    return { ...sample, elevationM: ema };
  });
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
