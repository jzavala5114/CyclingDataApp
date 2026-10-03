// --- Barometric elevation, one height per fix ------------------------------
//
// Zero imports on purpose. This is the decision logic only, so it runs under
// `node --test` with no React Native bridge, no emulator and no sensor. The
// OS-facing parts (requesting 5Hz, the ring buffer, draining it) live in the
// native module and in the background location task that calls this.
//
// What this replaces: a running sum/count accumulator in the task, drained
// once per GPS fix. Its window was "everything since the last drain", which is
// three different windows wearing one name:
//
//   * On a healthy ride it was one fix interval, 1-4s, trailing the fix.
//   * When the OS dropped a fix or suspended the task it was however long that
//     lasted, with no upper bound. A 60s gap averaged 60s of readings into one
//     height, and nothing in the stored sample said so.
//   * When expo-location delivered a BATCH of locations in one task call, the
//     first location drained the accumulator and the rest found it empty. They
//     were handed the first one's mean (that is what `lastBarometerRelativeM`
//     was for) or fell through to GPS altitude. Several fixes, one height.
//
// The native module now keeps TIMESTAMPED readings, so a fix can ask for the
// readings that belong to its own moment instead of taking whatever piled up
// since someone last looked. That is the entire change: the window is bounded,
// it is centred on the fix's own timestamp, and the same readings array
// answers every fix in a batch independently.

export interface PressureReading {
  /** Wall-clock milliseconds when the sensor sampled this reading. */
  atMs: number;
  /** Barometric pressure, hectopascals. */
  hPa: number;
}

export interface WindowedAltitude {
  /** Absolute barometric altitude, metres, from the barometric formula. */
  absoluteM: number;
  /** How many readings the mean came from. Always >= 1. */
  readingCount: number;
  /** Mean of (reading.atMs - fixAtMs) over the readings used. Negative = the
   *  window leaned earlier than the fix. */
  meanOffsetMs: number;
}

export interface WindowOptions {
  /** Readings within +/- this of the fix time are averaged. */
  halfWindowMs?: number;
}

// --- The conversion --------------------------------------------------------
//
// Kept byte-identical to the formula the accumulator already used, so any
// change in the archive after this ships is attributable to the windowing and
// not to a quietly improved atmosphere model. It is the standard-atmosphere
// barometric formula with a fixed sea-level reference, which means `absoluteM`
// is accurate in DIFFERENCES and wrong in LEVEL: 840 hPa reads 1553.96m here
// while the ground is near 1800m, because the real sea-level pressure on the
// day is not 1013.25. That is already how the pipeline works -- the DEM anchor
// sets the absolute level per ride, and only differences reach a gradient.
export const SEA_LEVEL_HPA = 1013.25;

export function altitudeFromPressureHpa(pressureHpa: number): number {
  return 44330 * (1 - Math.pow(pressureHpa / SEA_LEVEL_HPA, 1 / 5.255));
}

// --- The half-window ------------------------------------------------------
//
// Why 500ms, which is to say a window 1000ms wide:
//
// 1. It is half of the task's `MIN_INTERVAL_MS` (1000), the floor on the fix
//    interval. So even at the fastest fix rate the window is no wider than the
//    gap to the next fix, and neighbouring fixes essentially never average the
//    same reading. That matters because the backend differences neighbouring
//    elevations to get a gradient: shared readings correlate neighbours' noise,
//    the difference shrinks toward zero, and a real grade reads flatter than it
//    is. (Essentially, not exactly: two windows 1000ms apart both contain a
//    reading landing on the exact midpoint millisecond, because the bound is
//    inclusive at both ends. One reading out of five or six, only on exact
//    phase alignment. The alternative, a half-open window, buys that back by
//    making the window asymmetric about the fix by half a sensor period every
//    single fix, which is the worse trade.)
//
// 2. The task holds fixes ~`TARGET_SPACING_M` = 11m apart by deriving the
//    interval from speed, so 1000ms of riding is at most ~11m of road: the
//    window covers the fix's own stretch of road and never the next one's. At
//    3 m/s it covers 3m. The error this bounds is the reason the rule exists:
//    at 5 m/s on a 5% grade a 60-second window spans 300m of road and 15m of
//    height, and the mean of it sits ~7.5m from a fix at either end. The same
//    arithmetic at +/-500ms gives 2.5m of road and 0.125m of height. Even at
//    11 m/s on a 10% grade the worst case is 0.55m, and that worst case needs
//    every reading piled at one edge.
//
// 3. At the requested 200ms sampling it holds five or six readings, cutting
//    independent sensor noise by about 2.3x. That is what the old accumulator
//    achieved at its 1s floor, so the fast end of the ride loses nothing. The
//    slow end does give up some averaging (4s used to hold ~20 readings, a
//    4.5x cut) and that is the deliberate trade: those extra readings were
//    bought with up to 44m of smeared road, which is exactly the error the
//    0.29m-per-15m barometer was supposed to beat.
export const DEFAULT_HALF_WINDOW_MS = 500;

// A guard rail, not a preference. Rubric aside, the whole point of this module
// is that a height belongs to a place, and a caller asking for +/-30s is
// asking for the 15m error above whether they know it or not. 2000ms is half
// of the task's `MAX_INTERVAL_MS` (4000), the loosest window that still cannot
// reach past the neighbouring fix even at the slowest fix rate. Anything a
// caller asks for above this is clamped down to it rather than honoured;
// `resolveHalfWindowMs` is exported so a caller can ask what it will actually
// get, and `readingCount`/`meanOffsetMs` show the window that was used.
export const MAX_HALF_WINDOW_MS = 2000;

export function resolveHalfWindowMs(options?: WindowOptions): number {
  const requested = options?.halfWindowMs;
  // Zero and negative fall back to the default instead of being honoured.
  // A window that can match nothing is not a narrower window, it is "barometer
  // off for the whole ride", and there is no way to tell a caller who meant
  // that from a config path where a missing number arrived as 0. The expensive
  // failure is the silent one: a ride that quietly records GPS altitude
  // throughout looks like a ride, and the archive already had rides like that
  // with nothing in the data saying why. Callers who want the barometer off
  // do not call this function.
  if (requested == null || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_HALF_WINDOW_MS;
  }
  return Math.min(requested, MAX_HALF_WINDOW_MS);
}

// --- What counts as a reading ---------------------------------------------
//
// The bounds are physical, not statistical. 300 hPa is 9,165m by the formula
// above, well clear of the highest road a bicycle has ever been on (Umling La,
// ~5,800m, about 480 hPa). 1100 hPa is -698m, below the lowest road on earth
// on a record-high-pressure day (the record sea-level reading is 1083.8 hPa).
// So anything outside this is a sensor or bridge fault, never a height.
//
// Rejecting beats clamping here. A dropped reading disappears from the mean and,
// if it was the only one, the fix falls back to GPS altitude through the null
// path below. A clamped reading becomes a number that looks like data: the
// pathological 0.001 hPa that a half-initialised sensor hands back converts to
// a perfectly finite 41,139.6m, and clamping it to 300 hPa would turn that into
// a perfectly finite 9,165m. Both are plausible-looking wrong heights, and the
// second one is worse because it is in range.
export const MIN_PLAUSIBLE_HPA = 300;
export const MAX_PLAUSIBLE_HPA = 1100;

export function isUsableReading(reading: PressureReading | null | undefined): boolean {
  if (reading == null) return false;
  // `Number.isFinite` and not the global `isFinite`: this is a bridge boundary,
  // and the global coerces, so `isFinite("840")` is true and a string would
  // sail through into arithmetic. It also rejects NaN and both infinities,
  // either of which poisons a mean -- one NaN reading would otherwise cost
  // every fix whose window overlaps it, not just itself.
  if (!Number.isFinite(reading.atMs)) return false;
  if (!Number.isFinite(reading.hPa)) return false;
  return reading.hPa >= MIN_PLAUSIBLE_HPA && reading.hPa <= MAX_PLAUSIBLE_HPA;
}

// --- Selecting the window -------------------------------------------------
//
// Returns a NEW array and never touches the input. The caller holds one
// readings array for a whole delivered batch and asks this once per location,
// so sorting or splicing in place would corrupt the answers for every later
// fix in the batch. No module-level state either, for the same reason: the
// accumulator this replaces was state, and shared state across a batch is
// precisely how several fixes ended up with one height.
//
// A linear scan rather than a binary search over a sorted array. The native
// side is a ring buffer, so a drain that wrapped hands JS the oldest entries
// after the newest, and a binary search over that returns a wrong answer
// silently -- it would not throw, it would just quietly pick the wrong
// readings. Order-independence is bought here for nothing: a 60s ring at 5Hz
// is 300 entries, scanned once every 1-4 seconds.
export function readingsInWindow(
  readings: readonly PressureReading[],
  fixAtMs: number,
  options?: WindowOptions,
): PressureReading[] {
  // A native module that failed to produce anything hands JS `undefined`, and
  // `for...of` on that throws. A sensor misbehaving must cost elevation
  // precision for one fix, never the ride.
  if (!Array.isArray(readings)) return [];
  // NaN fix time has no window.
  //
  // NO TEST CAN KILL THIS LINE, and that is stated here rather than discovered
  // later. The bound below is a SELECTION (`<= half` keeps), and every
  // comparison against NaN is false, so a NaN fix time already selects nothing
  // and the caller already gets null. Mutation testing confirms it: deleting
  // this line leaves all 43 tests green.
  //
  // It stays because the sign of that bound is the only thing making it
  // redundant. Written the other way round as a REJECTION (`> half` skips) --
  // which is how someone optimising this into an early-continue loop would
  // naturally write it -- `NaN > half` is also false, so a NaN fix time would
  // admit EVERY reading in the buffer and hand back a mean over the whole ring
  // with a NaN offset. That is the unbounded window this module exists to
  // prevent, reachable by a refactor that looks like a tidy-up. The guard costs
  // one comparison per fix and closes it under either sign.
  if (!Number.isFinite(fixAtMs)) return [];

  const halfWindowMs = resolveHalfWindowMs(options);
  const kept: PressureReading[] = [];
  for (const reading of readings) {
    if (!isUsableReading(reading)) continue;
    // `Math.abs` is what makes this a window and not a cutoff. Without it
    // every reading older than the fix passes, which is the unbounded
    // "everything since last time" behaviour this module exists to kill.
    //
    // Symmetric, which means readings AFTER the fix timestamp are wanted. They
    // exist: a fix's `timestamp` is the GNSS fix time and it reaches the task
    // 100-500ms later, so by the time we are asked, part of the fix's future
    // has already been sampled. Keeping them is the difference between a
    // height centred on the fix and a height trailing it.
    //
    // A reading from the far future (a clock step, a bridge handing back a
    // nanosecond timestamp in a millisecond field) fails this same test and is
    // dropped, with no special case. That is the right answer rather than a
    // lucky one: there is no way to tell "the clock jumped" from "this reading
    // is not for this fix", and both have the same correct handling.
    //
    // Inclusive at the edge. A reading exactly `halfWindowMs` away is as much
    // "at the fix" as one a millisecond inside, and an exclusive bound makes
    // the reading count depend on how the sensor's phase happens to line up
    // with the fix clock.
    if (Math.abs(reading.atMs - fixAtMs) <= halfWindowMs) kept.push(reading);
  }
  return kept;
}

/** Returns null when no reading can be attributed to this fix. */
export function altitudeAtFix(
  readings: readonly PressureReading[],
  fixAtMs: number,
  options?: WindowOptions,
): WindowedAltitude | null {
  const inWindow = readingsInWindow(readings, fixAtMs, options);

  // THE NO-REGRESSION LINE. Every failure in this module funnels here: no
  // sensor, no readings, a sensor slower than the window, all readings
  // rejected as garbage, a NaN fix time, a bridge that handed back a non-array.
  // All of it becomes null, and null is the caller's signal to use GPS altitude
  // exactly as it did before the barometer existed. Nothing below widens the
  // window, reaches for the nearest reading outside it, or carries forward the
  // last good height. A reading three seconds away belongs to a different
  // place; GPS altitude at 0.65m per 15m is worse than the barometer's 0.29m
  // but it is honest, and the sample's `source` field records which was used so
  // the archive stays readable.
  if (inWindow.length === 0) return null;

  // Average the PRESSURE, then convert. Two reasons, in order of weight:
  //
  // 1. The sensor's noise lives in pressure. Averaging n readings only cancels
  //    noise in the quantity that is actually noisy, so the mean has to be
  //    taken there. Converting first averages n numbers whose errors have
  //    already been through a power law.
  // 2. The formula is a power law, so the mean of the altitudes is not the
  //    altitude of the mean pressure (Jensen's inequality, and the curve is
  //    convex here so convert-then-average reads HIGH). Measured at 840 hPa:
  //    a realistic +/-0.12 hPa window differs by 3.4e-5 m, a +/-2 hPa window
  //    by 9.3e-3 m, and a +/-20 hPa window by 0.93m. So at today's window this
  //    is worth micrometres and is not why the ride looks the way it does.
  //    It costs nothing to be right, it keeps the bias from growing if the
  //    window ever widens, and the alternative is a known-wrong order of
  //    operations sitting in the one place the sensor's advantage is created.
  let pressureSum = 0;
  // Offsets are differenced against the fix before summing, not summed as raw
  // epoch milliseconds and differenced after. Both are exact in float64 at
  // these magnitudes (epoch ms is ~1.8e12, far under 2^53), so this is habit
  // rather than necessity, but it keeps the running total near zero instead of
  // near 1e13.
  let offsetSum = 0;
  for (const reading of inWindow) {
    pressureSum += reading.hPa;
    offsetSum += reading.atMs - fixAtMs;
  }
  const readingCount = inWindow.length;

  // `meanOffsetMs` is reported rather than corrected for, and that is a
  // decision, not an omission. In practice the window IS lopsided: with the
  // fix timestamp arriving 100-500ms late, readings fill the earlier side more
  // completely, leaving a mean offset around -100 to -250ms. At 11 m/s that is
  // 1.1-2.8m of road, and on a 10% grade 0.11-0.28m of height, at or under the
  // sensor's own 0.29m-per-15m noise. It is also near-CONSTANT from fix to fix,
  // and the task holds fix spacing near-constant in distance, so it acts as a
  // fixed shift along the segment and cancels out of a slope -- the same
  // argument the old accumulator's half-interval lag rested on. Re-weighting
  // readings to force the mean offset to zero would trade that constant,
  // cancelling bias for a variable one that depends on which readings happened
  // to land, which is strictly worse for a gradient. Reporting it means the
  // archive can measure the bias per ride instead of us guessing at it.
  return {
    absoluteM: altitudeFromPressureHpa(pressureSum / readingCount),
    readingCount,
    meanOffsetMs: offsetSum / readingCount,
  };
}

// --- The bridge shape ------------------------------------------------------
//
// `readWindowAsync` hands back a FLAT `[atMs, hPa, atMs, hPa, ...]` rather than
// an array of objects, because a screen-off stretch can return hundreds of
// readings in one call and building a JavaScript object for each one costs more
// than every piece of arithmetic in this file put together. It is also the one
// return shape Expo's converter passes through untouched, which matters on a
// path that only ever runs on a phone: a conversion failure here would surface
// as a ride silently recorded on GPS altitude, not as an error anybody sees.
//
// Lives in this module, with no imports, so the decoding is pinned by tests
// rather than by a successful ride.
export function decodeReadings(
  flat: ArrayLike<number> | null | undefined,
): PressureReading[] {
  // The facade returns `[]` when the native module is missing, but a bridge
  // that resolved with null or with something that is not indexable has to land
  // somewhere too, and `length` on null throws.
  if (flat == null || typeof flat.length !== "number" || !Number.isFinite(flat.length)) {
    return [];
  }

  // An odd length means the payload was truncated mid-pair. The orphan is
  // dropped rather than paired with `undefined`, which would become a NaN
  // pressure, and `>>> 1` rounds the pair count down for free. Dropping one
  // reading costs nothing: the window holds five or six.
  const pairs = flat.length >>> 1;
  const readings: PressureReading[] = new Array(pairs);
  for (let i = 0; i < pairs; i++) {
    readings[i] = { atMs: flat[i * 2] as number, hPa: flat[i * 2 + 1] as number };
  }

  // Deliberately NOT filtered here. `isUsableReading` is the single place that
  // decides what a reading has to look like, and running it twice would let the
  // two copies drift until a reading the window accepts is one the decoder
  // already threw away, or the reverse.
  return readings;
}
