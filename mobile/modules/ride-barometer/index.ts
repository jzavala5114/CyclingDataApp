import { requireOptionalNativeModule } from "expo";

// A thin typed wrapper over the native module and nothing else. Every decision
// -- which readings belong to which fix, how a pressure becomes a height --
// lives in `src/services/barometerWindow.ts`, which has no imports at all and
// therefore runs under `node:test` without a device. Logic that ends up in here
// is logic that can only be checked by riding a bicycle.

/**
 * What the device can actually do, read once when a ride starts.
 *
 * Recorded because a disappointing test ride has two very different causes --
 * the module not working, or the phone not having the hardware to do better --
 * and after the fact there is no way to tell them apart from the ride data.
 */
export interface BarometerStatus {
  available: boolean;
  /**
   * True when the wake-up variant of the pressure sensor exists, meaning the
   * SoC is woken to deliver readings. Most phones only have the non-wake
   * variant, which keeps reporting only while the CPU happens to be up.
   */
  wakeUp: boolean;
  name: string | null;
  vendor: string | null;
  /** Smallest reportable change, hPa. 0.01 hPa is roughly 8cm of air. */
  resolutionHpa: number | null;
  minDelayUs: number | null;
  maxDelayUs: number | null;
  /** Zero means no hardware FIFO, so nothing survives a CPU suspend. */
  fifoMaxEventCount: number | null;
  powerMa: number | null;
}

/** Running totals since the ride started. `delivered` over the elapsed time is
 *  the real sampling rate, which is the number that says whether the sensor
 *  stayed alive through a locked screen. */
export interface BarometerCounters {
  registered: boolean;
  wakeUp: boolean;
  requestedIntervalMs: number;
  delivered: number;
  /** Readings thrown away for being non-finite. A failing sensor, not a bug. */
  dropped: number;
  /** Readings whose timestamp had to be replaced with "now" because the
   *  device's sensor clock did not agree with its boot clock. A high count
   *  means the per-fix windowing has degraded to "the newest readings". */
  repaired: number;
  held: number;
  startedAtMs: number | null;
}

interface RideBarometerNative {
  getStatusAsync(): Promise<BarometerStatus>;
  startAsync(intervalMs: number): Promise<boolean>;
  stopAsync(): Promise<boolean>;
  readWindowAsync(fromMs: number, toMs: number): Promise<ArrayLike<number>>;
  getCountersAsync(): Promise<BarometerCounters>;
}

// Android only, so this is null on iOS, on web, and in Expo Go. Optional rather
// than required for that reason: `requireNativeModule` throws, and a throw here
// would take down the module that imports it at load time rather than letting
// the ride fall back to `expo-sensors`.
const native = requireOptionalNativeModule<RideBarometerNative>("RideBarometer");

/** Whether the native module is in this build at all. False on iOS and in Expo
 *  Go, where the caller should use the `expo-sensors` path instead. */
export function isLinked(): boolean {
  return native != null;
}

// Every call below swallows its own failure and reports "no barometer". That is
// the no-regression guarantee: a native module that is missing, or broken, or
// throwing on a device nobody tested, produces exactly the behaviour the app had
// before it existed -- GPS altitude -- rather than an unhandled rejection inside
// a background task that Android would not show anyone.

export async function getStatusAsync(): Promise<BarometerStatus | null> {
  if (!native) return null;
  try {
    return await native.getStatusAsync();
  } catch (err) {
    console.warn("ride-barometer: getStatusAsync failed", err);
    return null;
  }
}

/** Registers the listener. Safe to call again mid-ride: the same interval is a
 *  no-op rather than a re-registration. */
export async function startAsync(intervalMs: number): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.startAsync(intervalMs);
  } catch (err) {
    console.warn("ride-barometer: startAsync failed", err);
    return false;
  }
}

export async function stopAsync(): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.stopAsync();
  } catch (err) {
    console.warn("ride-barometer: stopAsync failed", err);
    return false;
  }
}

/**
 * Readings sampled in `[fromMs, toMs]`, flat as `[atMs, hPa, atMs, hPa, ...]`.
 *
 * Returned flat because that is what crosses the bridge without building one
 * object per reading, and a screen-off stretch can hand back hundreds at once.
 * `decodeReadings` in `barometerWindow.ts` turns it into something readable, and
 * is where the shape is pinned by tests.
 */
export async function readWindowAsync(fromMs: number, toMs: number): Promise<ArrayLike<number>> {
  if (!native) return [];
  try {
    return await native.readWindowAsync(fromMs, toMs);
  } catch (err) {
    console.warn("ride-barometer: readWindowAsync failed", err);
    return [];
  }
}

export async function getCountersAsync(): Promise<BarometerCounters | null> {
  if (!native) return null;
  try {
    return await native.getCountersAsync();
  } catch (err) {
    console.warn("ride-barometer: getCountersAsync failed", err);
    return null;
  }
}
