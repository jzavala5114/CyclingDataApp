import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import type { TrackedSample } from "../types";

export const LOCATION_TASK_NAME = "cyclingdataapp-location-updates";
const SAMPLE_BUFFER_KEY = "cyclingdataapp:sample-buffer";

// --- GPS power modes -------------------------------------------------------
//
// Straight, steady riding doesn't need navigation-grade fixes every second --
// the segment matcher only needs to know which street we're on. Turns are
// where precision matters, both for picking the right segment and for not
// cutting the corner onto a parallel way. So we cruise cheaply and only pay
// for high-rate fixes around heading changes.
//
// On Android the accuracy enum mostly maps onto the same high-accuracy
// provider, so the interval/distance settings below are doing most of the
// real power saving, not the accuracy tier.
const BASE_OPTIONS = {
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: "Recording your ride",
    notificationBody: "Tracking GPS and elevation. Tap to return to the app.",
    notificationColor: "#16a34a",
  },
} satisfies Partial<Location.LocationTaskOptions>;

// --- Spatial, not temporal, sampling ---------------------------------------
//
// A fix arrives no sooner than `timeInterval` and no closer than
// `distanceInterval`, so at speed the clock is what binds and the spacing
// between fixes grows with how fast you are going. Measured over sessions
// 11-14 against the backend's 15m buckets:
//
//   2-4 m/s   7.9m apart    0.5 buckets
//   4-6 m/s  13.6m apart    0.9 buckets
//   6-8 m/s  17.6m apart    1.2 buckets  <- buckets start going unmeasured
//   8-10 m/s 26.4m apart    1.8 buckets
//   10+ m/s  34.1m apart    2.3 buckets
//
// Descents are the fastest part of any ride, so a fixed interval samples them
// least -- exactly backwards. Deriving the interval from speed holds the
// spacing roughly constant instead, which is what the bucketing wants.
//
// This is close to power-neutral rather than a straight cost: climbing at
// 3 m/s now gets a *longer* interval than the flat 3s it replaces, which pays
// for the shorter one on the way back down.
const TARGET_SPACING_M = 11;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 4000;
// Quantised so that ordinary speed wobble doesn't restart the location
// provider every few seconds chasing a number that barely moved.
const INTERVAL_STEP_MS = 500;

function intervalForSpeed(speedMps: number | null | undefined): number {
  // Android reports -1 rather than null when speed is unavailable.
  if (speedMps == null || !(speedMps > 0)) return MAX_INTERVAL_MS;
  const ideal = (TARGET_SPACING_M / speedMps) * 1000;
  const clamped = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, ideal));
  return Math.round(clamped / INTERVAL_STEP_MS) * INTERVAL_STEP_MS;
}

// Accuracy.High is ~10m -- still well inside the matcher's tolerance. Anything
// coarser (Balanced is ~100m) would be too imprecise to tell one street from
// the next. timeInterval here is only the starting point; it is replaced from
// speed on every fix.
export const CRUISE_OPTIONS: Location.LocationTaskOptions = {
  ...BASE_OPTIONS,
  accuracy: Location.Accuracy.High,
  timeInterval: MAX_INTERVAL_MS,
  distanceInterval: 10,
};

export const TURN_OPTIONS: Location.LocationTaskOptions = {
  ...BASE_OPTIONS,
  accuracy: Location.Accuracy.BestForNavigation,
  timeInterval: MIN_INTERVAL_MS,
  distanceInterval: 3,
};

const TURN_ENTER_HEADING_DELTA_DEG = 20;
const TURN_COOLDOWN_MS = 5000;
const MIN_MS_BETWEEN_MODE_SWITCHES = 5000;

let mode: "cruise" | "turn" = "cruise";
let currentIntervalMs = MAX_INTERVAL_MS;
let lastHeadingDeg: number | null = null;
let lastTurnAtMs = 0;
let lastModeSwitchAtMs = 0;

function headingDelta(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// --- Elevation sources -----------------------------------------------------
//
// expo-sensors has no background counterpart to expo-location's task, so
// barometer readings stop arriving once the screen goes off. We keep the
// newest reading in module scope with the time it arrived: fresh readings get
// used, stale ones are ignored in favour of GPS altitude.
//
// The two sources are on different scales -- the barometer gives metres
// *relative* to where tracking started, GPS gives absolute metres above sea
// level (~1800m here). Mixing them raw would put an ~1800m cliff into the
// elevation series every time the screen turned off, which would swamp the
// real gradient entirely. Anchoring the relative readings to the session's
// first GPS altitude keeps every sample on one absolute scale.
const BAROMETER_STALE_AFTER_MS = 5000;
let barometerRelativeM: number | null = null;
let barometerAtMs = 0;
let baselineGpsAltitudeM: number | null = null;

export function recordBarometerAltitude(relativeM: number): void {
  barometerRelativeM = relativeM;
  barometerAtMs = Date.now();
}

export function resetTrackingState(): void {
  mode = "cruise";
  currentIntervalMs = MAX_INTERVAL_MS;
  lastHeadingDeg = null;
  lastTurnAtMs = 0;
  lastModeSwitchAtMs = 0;
  barometerRelativeM = null;
  barometerAtMs = 0;
  baselineGpsAltitudeM = null;
}

function elevationFor(location: Location.LocationObject): number | null {
  const gpsAltitude = location.coords.altitude;
  if (baselineGpsAltitudeM == null && gpsAltitude != null) baselineGpsAltitudeM = gpsAltitude;

  const barometerIsFresh =
    barometerRelativeM != null && Date.now() - barometerAtMs < BAROMETER_STALE_AFTER_MS;

  if (barometerIsFresh && baselineGpsAltitudeM != null) {
    return baselineGpsAltitudeM + barometerRelativeM!;
  }
  return gpsAltitude;
}

// --- Sample buffer ---------------------------------------------------------
//
// The task can be invoked while React state is unavailable (screen off, JS
// context paused and resumed), so samples land in AsyncStorage rather than in
// component state, and are drained when the ride is stopped. Writes are
// chained because a read-modify-write on the buffer would otherwise race
// between overlapping task invocations.
let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite(work: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(work, work);
  return writeChain;
}

async function appendSamples(samples: TrackedSample[]): Promise<void> {
  const raw = await AsyncStorage.getItem(SAMPLE_BUFFER_KEY);
  const existing: TrackedSample[] = raw ? JSON.parse(raw) : [];
  await AsyncStorage.setItem(SAMPLE_BUFFER_KEY, JSON.stringify([...existing, ...samples]));
}

export async function readBufferedSamples(): Promise<TrackedSample[]> {
  const raw = await AsyncStorage.getItem(SAMPLE_BUFFER_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function clearBufferedSamples(): Promise<void> {
  await enqueueWrite(() => AsyncStorage.removeItem(SAMPLE_BUFFER_KEY));
}

// Drops the oldest `count` samples, keeping anything the task has appended
// since. Called as each upload chunk is acknowledged, so an upload interrupted
// half way resumes from where it stopped rather than re-sending the ride.
export async function dropBufferedSamples(count: number): Promise<void> {
  await enqueueWrite(async () => {
    const raw = await AsyncStorage.getItem(SAMPLE_BUFFER_KEY);
    const existing: TrackedSample[] = raw ? JSON.parse(raw) : [];
    await AsyncStorage.setItem(SAMPLE_BUFFER_KEY, JSON.stringify(existing.slice(count)));
  });
}

// --- Active session --------------------------------------------------------
//
// Location updates are registered with the OS and outlive the app: Android
// can tear down and relaunch the JS context mid-ride, and the task keeps
// running either way. Recording which session is in flight lets a relaunch
// pick the ride back up instead of stranding it, and lets startup recognise a
// task still running with no ride behind it and shut it off rather than leave
// it draining the battery invisibly.
const ACTIVE_SESSION_KEY = "cyclingdataapp:active-session";

// `sessionId` is null for a ride that has not been given a server session yet.
// Rides now start offline and are only registered with the server when there is
// something worth saving, so for most of a ride's life this is null.
export interface ActiveSession {
  sessionId: number | null;
  startedAt: string;
}

export async function setActiveSession(session: ActiveSession | null): Promise<void> {
  if (session) await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
  else await AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
}

export async function getActiveSession(): Promise<ActiveSession | null> {
  const raw = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

// Retunes the running location updates: turn vs cruise accuracy, and the
// cruise interval that keeps fixes a roughly constant distance apart. Guarded
// so a burst of heading or speed changes can't thrash the location provider,
// and so a failed swap degrades to "keep the current settings" rather than
// dropping tracking altogether mid-ride.
async function updateModeFor(location: Location.LocationObject): Promise<void> {
  const heading = location.coords.heading;
  const now = Date.now();

  if (heading != null && heading >= 0) {
    if (lastHeadingDeg != null && headingDelta(heading, lastHeadingDeg) >= TURN_ENTER_HEADING_DELTA_DEG) {
      lastTurnAtMs = now;
    }
    lastHeadingDeg = heading;
  }

  const wantsTurnMode = now - lastTurnAtMs < TURN_COOLDOWN_MS;
  const nextMode = wantsTurnMode ? "turn" : "cruise";
  const nextIntervalMs =
    nextMode === "turn" ? MIN_INTERVAL_MS : intervalForSpeed(location.coords.speed);

  if (nextMode === mode && nextIntervalMs === currentIntervalMs) return;
  if (now - lastModeSwitchAtMs < MIN_MS_BETWEEN_MODE_SWITCHES) return;

  try {
    await Location.startLocationUpdatesAsync(
      LOCATION_TASK_NAME,
      nextMode === "turn"
        ? TURN_OPTIONS
        : { ...CRUISE_OPTIONS, timeInterval: nextIntervalMs },
    );
    mode = nextMode;
    currentIntervalMs = nextIntervalMs;
    lastModeSwitchAtMs = now;
  } catch (err) {
    console.warn("failed to retune GPS", err);
  }
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.warn("location task error", error);
    return;
  }

  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  if (!locations?.length) return;

  const samples: TrackedSample[] = [];
  for (const location of locations) {
    const elevationM = elevationFor(location);
    if (elevationM == null) continue; // no usable altitude yet -- skip rather than invent one
    samples.push({
      recordedAt: new Date(location.timestamp).toISOString(),
      lat: location.coords.latitude,
      lon: location.coords.longitude,
      elevationM,
      headingDeg: location.coords.heading,
      speedMps: location.coords.speed,
      accuracyM: location.coords.accuracy,
    });
  }

  if (samples.length > 0) await enqueueWrite(() => appendSamples(samples));
  await updateModeFor(locations[locations.length - 1]);
});
