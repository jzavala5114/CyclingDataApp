// --- What the barometer is doing, in one line ------------------------------
//
// Zero imports, like `barometerWindow.ts` and for the same reason: this runs
// under `node --test`.
//
// This exists because of how the change it reports on has to be measured. The
// barometer dying when the screen locks is a phone behaviour, so the only
// instrument is a ride -- and on a ride there is no debugger, no console, and
// no second device. The rider unlocks the phone, looks at one line, and has to
// be able to tell "the sensor is alive" from "the sensor registered and is
// delivering nothing", which are the two outcomes that look identical in every
// other way until the ride is uploaded an hour later.

export interface BarometerHealth {
  /** `native` is the module that survives a locked screen. `sensors` is
   *  `expo-sensors`, which does not. `none` means no pressure sensor at all. */
  path: "native" | "sensors" | "none";
  /** Whether the native listener is still registered. Carried because the
   *  module can stop on its own -- `OnDestroy` fires on a module-registry
   *  teardown, which a development reload does while the ride continues -- and
   *  without this field that state rendered as "Barometer starting" for the
   *  rest of the ride. */
  registered: boolean;
  /** Readings per second the sensor delivered. Detail, not the decision: see
   *  `usedShare`. */
  hz: number | null;
  readings: number | null;
  /** Timestamps the native module had to replace with "now" because the
   *  device's sensor clock did not agree with its boot clock. */
  repaired: number | null;
  /** Whether the wake-up sensor variant was obtained. False is normal. */
  wakeUp: boolean;
  /**
   * Share of the most recent fixes that came out with a barometric height.
   *
   * THE DECISION RESTS ON THIS, not on `hz`, and a cold review is why. A sensor
   * whose clock disagrees with the phone's by anywhere from half a second to
   * two minutes delivers readings at a perfect 5Hz that land in no fix's
   * window: `hz` reads healthy, `readings` climbs into the thousands, and every
   * stored height is GPS. Counting readings that ARRIVED rather than readings
   * that were USED is how that reads as success. This is also the same quantity
   * the backend scores after the ride, so the line on the phone and the verdict
   * from `verify-barometer` cannot disagree.
   */
  usedShare: number | null;
}

// The sampling period the app asks for is 200ms, so a healthy sensor delivers
// 5 readings a second. Half of that is the line between "slower than asked,
// which is the OS's right" and "something is wrong".
//
// 2.5 is also the rate `expo-sensors` has actually been delivering, because its
// software throttle compares `currentTime - lastUpdate > updateInterval` and
// drops readings arriving at exactly the requested spacing. So a native path
// reporting under this is doing no better than the thing it replaced.
export const HEALTHY_HZ = 2.5;

// Below this share of recent fixes carrying a barometric height, the sensor is
// contributing but not reliably. Set at four fifths rather than at everything,
// because an occasional fix landing in a gap between readings is normal and
// does not need a warning on screen.
export const HEALTHY_USED_SHARE = 0.8;

export type BarometerVerdict =
  | "good"
  | "patchy"
  | "slow"
  | "silent"
  | "offline"
  | "degraded"
  | "fallback"
  | "absent";

/**
 * The call. Separate from the text below so the two cannot disagree, and so a
 * test can pin the decision without matching on a string.
 *
 * Ordered most-serious first. `silent` is the one that matters: a native path
 * that registered the listener and is producing no barometric fixes is the
 * exact failure this whole change could have, and for a while the code could
 * name that state without anything acting on it.
 */
export function verdictFor(health: BarometerHealth | null): BarometerVerdict {
  if (health == null || health.path === "none") return "absent";
  if (health.path === "sensors") return "fallback";
  if (!health.registered) return "offline";
  // No fixes yet, so nothing to judge. Not silence -- reporting it as such
  // would put a warning on screen at the start of every ride.
  if (health.usedShare == null) {
    return health.hz != null && health.hz <= 0 ? "silent" : "good";
  }
  if (health.usedShare === 0) return "silent";
  if (health.hz != null && health.hz <= 0) return "silent";
  if (health.repaired != null && health.repaired > 0) return "degraded";
  if (health.usedShare < HEALTHY_USED_SHARE) return "patchy";
  return health.hz != null && health.hz < HEALTHY_HZ ? "slow" : "good";
}

function round(value: number, places: number): string {
  return value.toFixed(places);
}

/**
 * One line for the map, written to be read at a glance by someone standing over
 * a bicycle. Short enough not to wrap, and it leads with the thing that is
 * wrong when something is wrong.
 */
export function describeBarometer(health: BarometerHealth | null): string {
  const verdict = verdictFor(health);
  switch (verdict) {
    case "absent":
      return "No barometer -- elevation from GPS";
    case "fallback":
      // Named rather than hidden, because on this path a locked screen still
      // costs the barometer and the rider should know the ride is not the
      // experiment they think it is.
      return "Barometer via expo-sensors -- stops when the screen locks";
    case "offline":
      return "Barometer STOPPED -- elevation from GPS";
    case "silent":
      return "Barometer registered but SILENT -- elevation from GPS";
    case "patchy":
      return `Barometer patchy: ${round(100 * health!.usedShare!, 0)}% of recent fixes`;
    case "slow":
      return `Barometer slow: ${round(health!.hz!, 1)} Hz`;
    case "degraded":
      return `Barometer ${round(health!.hz ?? 0, 1)} Hz, ${health!.repaired} bad timestamps`;
    case "good": {
      if (health!.usedShare == null) return "Barometer starting";
      const wake = health!.wakeUp ? ", wake-up" : "";
      return `Barometer ${round(100 * health!.usedShare, 0)}% of fixes, ${round(health!.hz ?? 0, 1)} Hz${wake}`;
    }
  }
}

// --- Giving up on the native path ------------------------------------------
//
// A cold review broke the no-regression claim on exactly this, and it was the
// worst defect in the change. `startAsync` returns true when Android ACCEPTS
// the sensor registration, not when a reading arrives. The hook took that as
// success and never subscribed `expo-sensors`, so a sensor that registered and
// then stayed quiet cost the ride its barometer completely -- not just the
// screen-off part, the screen-on part too, which worked before any of this.
// There was no recovery, and `verdictFor` above already had a word for the
// state (`silent`) while nothing acted on it.
//
// So the ride now watches the only thing that actually matters: whether fixes
// are coming out with a barometric height on them. That is the same quantity
// the backend will score after the ride, which is the point -- a watchdog
// measuring something else could pass while the stored data fails.

/** How long the native path gets to produce its first barometric fix. At a fix
 *  every 1-4 seconds this is 5-20 fixes, enough to be sure rather than unlucky,
 *  and it bounds the cost of a dead sensor to the opening of the ride. */
export const NATIVE_PROVE_ITSELF_MS = 20_000;

/** Below this there is not enough evidence to convict. A ride that has produced
 *  three fixes in twenty seconds has a GPS problem, not a barometer problem,
 *  and switching sensors would not help it. */
export const MIN_FIXES_TO_JUDGE = 5;

/** How many of the most recent fixes the decision looks at. Recent rather than
 *  all, so a sensor that dies an hour into a ride is still caught. */
export const HEALTH_WINDOW_FIXES = 10;

/**
 * Should the ride stop trusting the native module and fall back to
 * `expo-sensors`?
 *
 * `every`, not `some`. One barometric fix in the window means the path works
 * and the rest is ordinary gapping; it takes a clean sweep of GPS to convict.
 * The same discipline the segment-fate verdicts in the backend settled on, and
 * for the same reason: the expensive mistake is acting on partial silence.
 *
 * One-way on purpose. Switching back on recovery would mean two sensors feeding
 * one ride with two different zero points, and a step in the elevation series
 * at every handover.
 */
export function shouldAbandonNative(
  elapsedMs: number,
  recentSources: readonly ("barometer" | "gps")[],
): boolean {
  // Written as `>=` inside a negation so a NaN elapsed time -- which a missing
  // `startedAtMs` could produce -- answers false rather than true. Abandoning
  // the better sensor on an arithmetic slip is the expensive direction.
  if (!(elapsedMs >= NATIVE_PROVE_ITSELF_MS)) return false;
  if (recentSources.length < MIN_FIXES_TO_JUDGE) return false;
  return recentSources.every((source) => source !== "barometer");
}

/** Share of the recent fixes that came out barometric, or null when there are
 *  none to judge. Null and zero are different answers and only one is
 *  evidence. */
export function recentBarometerShare(
  recentSources: readonly ("barometer" | "gps")[],
): number | null {
  if (recentSources.length === 0) return null;
  return recentSources.filter((source) => source === "barometer").length / recentSources.length;
}
