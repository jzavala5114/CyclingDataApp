import type { SessionSample } from "../types/index.js";

// A GPS fix that jumped sideways and came back.
//
// `rejectElevationSpikes` catches a fix that claims the wrong HEIGHT between
// two neighbours. Nothing catches a fix that claims the wrong PLACE. Downtown,
// a signal bouncing off a building puts a fix 15m across the road with a
// reported accuracy of 8m, so the 30m accuracy filter admits it, the matcher
// takes it at face value, and the ride appears to weave.
//
// The test here is the same shape as the elevation one, rotated into the
// horizontal plane: compare a fix against where it would be if the rider had
// travelled straight between the fix before and the fix after. A real rider
// turning a corner deviates from that chord too, so deviation alone is not
// enough -- what distinguishes a spike is deviating a long way while making
// almost no progress along the chord. A corner advances; a spike does not.
//
// Nothing here rejects anything or is wired into the matcher. It measures, so
// a threshold can be chosen from the archive rather than guessed.

/** Metres per degree of latitude. The equirectangular approximation is good to
 * a fraction of a percent over the few hundred metres between two fixes. */
const M_PER_DEG_LAT = 111_320;

/** Below this, a chord has no direction worth measuring against. */
export const MIN_CHORD_M = 2;

export interface SpikeMeasure {
  /** Index into the sample array. Never the first or last fix. */
  index: number;
  sampleId: number;
  /** Perpendicular distance from the chord between the neighbouring fixes. */
  crossTrackM: number;
  /** Distance along that chord from the first neighbour to the projection. */
  alongTrackM: number;
  /** Length of the chord itself: how far the rider got in those two steps. */
  chordM: number;
  /** Fastest implied ground speed of the two legs, in m/s. */
  impliedMps: number;
  /** What the device said its speed was, if it said. */
  reportedMps: number | null;
  /** What the device said its horizontal accuracy was, if it said. */
  accuracyM: number | null;
  /** Seconds covered by the two legs. */
  spanS: number;
}

/** Local east/north offsets in metres from `from` to `to`. */
function offsetM(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): { east: number; north: number } {
  const cosLat = Math.cos((from.lat * Math.PI) / 180);
  return {
    east: (to.lon - from.lon) * M_PER_DEG_LAT * cosLat,
    north: (to.lat - from.lat) * M_PER_DEG_LAT,
  };
}

const hypot = (a: { east: number; north: number }) => Math.hypot(a.east, a.north);

/**
 * How far each fix sits from the straight line between its neighbours.
 *
 * Measured against the RAW neighbours rather than the last fix kept, unlike
 * `rejectElevationSpikes`. This function rejects nothing, so there is no "kept"
 * to compare against, and a measurement that silently changed its own reference
 * would be hard to reason about. The consequence is that two adjacent spikes
 * partly hide each other, which is stated in the report rather than corrected
 * for: it makes this an UNDER-count, which is the safe direction for a number
 * being used to decide whether a problem exists.
 *
 * The first and last fix have no pair of neighbours and are never measured.
 */
export function measurePositionSpikes(
  samples: readonly SessionSample[],
  minChordM = MIN_CHORD_M,
): SpikeMeasure[] {
  const out: SpikeMeasure[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const before = samples[i - 1]!;
    const sample = samples[i]!;
    const after = samples[i + 1]!;
    if (![before.lat, before.lon, sample.lat, sample.lon, after.lat, after.lon].every(Number.isFinite)) {
      continue;
    }

    const chord = offsetM(before, after);
    const toSample = offsetM(before, sample);
    const chordM = hypot(chord);

    // With the neighbours in the same place there is no chord to measure
    // against, and the distance to that point is the honest answer.
    const crossTrackM =
      chordM < minChordM
        ? hypot(toSample)
        : Math.abs(chord.east * toSample.north - chord.north * toSample.east) / chordM;
    const alongTrackM =
      chordM < minChordM ? 0 : (chord.east * toSample.east + chord.north * toSample.north) / chordM;

    const t0 = Date.parse(before.recordedAt);
    const t1 = Date.parse(sample.recordedAt);
    const t2 = Date.parse(after.recordedAt);
    const legA = (t1 - t0) / 1000;
    const legB = (t2 - t1) / 1000;
    const toAfter = hypot(offsetM(sample, after));
    const speedA = legA > 0 ? hypot(toSample) / legA : Infinity;
    const speedB = legB > 0 ? toAfter / legB : Infinity;

    out.push({
      index: i,
      sampleId: sample.id,
      crossTrackM,
      alongTrackM,
      chordM,
      impliedMps: Math.max(speedA, speedB),
      reportedMps: sample.speedMps,
      accuracyM: sample.accuracyM,
      spanS: (t2 - t0) / 1000,
    });
  }
  return out;
}

/**
 * Is this measurement a spike rather than a corner?
 *
 * Two conditions, and both are needed. A fix must be far enough off the chord
 * to matter, and the rider must have gone almost nowhere while it happened: a
 * genuine right-angle turn at speed puts a fix well off its chord, but the
 * chord is long because the rider covered ground. A spike has a long cross
 * track and a short chord, which is the signature of leaving and returning.
 *
 * `crossToChord` is the ratio that separates them. At 0.5, a fix 15m off a 30m
 * chord is a corner and a fix 15m off a 20m chord is a spike.
 */
export function isSpike(
  m: SpikeMeasure,
  { minCrossM, crossToChord }: { minCrossM: number; crossToChord: number },
): boolean {
  if (!(m.crossTrackM >= minCrossM)) return false;
  // A zero-length chord means the rider did not move at all, so any deviation
  // is pure noise and the ratio is unbounded.
  if (m.chordM <= 0) return true;
  return m.crossTrackM / m.chordM >= crossToChord;
}

/** Quantiles of a set of numbers, for reporting a distribution. */
export function quantiles(
  values: readonly number[],
  ps: readonly number[],
): Array<{ p: number; value: number }> {
  const finite = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return ps.map((p) => ({
    p,
    value: finite.length
      ? finite[Math.min(finite.length - 1, Math.floor(p * finite.length))]!
      : NaN,
  }));
}
