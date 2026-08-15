import type { SessionSample } from "../types/index.js";

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
