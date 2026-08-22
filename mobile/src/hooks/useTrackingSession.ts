import { useCallback, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { Barometer } from "expo-sensors";
import {
  CRUISE_OPTIONS,
  LOCATION_TASK_NAME,
  clearBufferedSamples,
  getActiveSession,
  readBufferedSamples,
  recordBarometerAltitude,
  resetTrackingState,
  setActiveSession,
} from "../services/backgroundLocationTask";
import type { TrackedSample } from "../types";

// iOS's Barometer reports `relativeAltitude` (metres, relative to wherever
// tracking started) directly. Android only exposes raw `pressure` (hPa), so
// there we derive altitude from the barometric formula and subtract the
// session's first reading to get the same relative measure. The absolute
// value from this formula depends on the day's sea-level pressure and isn't
// trustworthy, but the *changes* are -- which is why it's anchored to a GPS
// baseline in backgroundLocationTask.ts rather than used as-is.
const SEA_LEVEL_HPA = 1013.25;

function pressureToAltitudeM(pressureHpa: number): number {
  return 44330 * (1 - Math.pow(pressureHpa / SEA_LEVEL_HPA, 1 / 5.255));
}

// The background task writes samples to AsyncStorage rather than React state,
// so the live breadcrumb polls the buffer instead of receiving each fix.
const BREADCRUMB_POLL_MS = 2000;

// A ride sitting on the phone that was never saved to the server. sessionId is
// null when the pointer to it was already lost -- earlier builds cleared it on
// launch and left the samples orphaned in storage, so a recovered ride may have
// nothing left to attach to and needs a fresh session.
export interface UnsavedRide {
  sessionId: number | null;
  sampleCount: number;
}

export function useTrackingSession() {
  const [isTracking, setIsTracking] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  // When the ride began, kept on the phone because the server session is not
  // created until the ride is saved -- by which time "now" is the end of it.
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [samples, setSamples] = useState<TrackedSample[]>([]);
  const [unsavedRide, setUnsavedRide] = useState<UnsavedRide | null>(null);

  const baselinePressureAltitudeM = useRef<number | null>(null);
  const barometerSubscription = useRef<ReturnType<typeof Barometer.addListener> | null>(null);

  // Reconcile with whatever the OS is still doing from a previous launch.
  useEffect(() => {
    (async () => {
      const [active, taskRunning] = await Promise.all([
        getActiveSession(),
        Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME),
      ]);

      const buffered = await readBufferedSamples();

      if (active && taskRunning) {
        // A ride outlived the app being torn down -- resume it.
        setSessionId(active.sessionId);
        setStartedAt(active.startedAt);
        setIsTracking(true);
        setSamples(buffered);
      } else if (taskRunning) {
        // Updates running with no ride behind them: stop rather than let them
        // drain the battery with no UI to turn them off.
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      } else if (active && buffered.length > 0) {
        // Tracking has stopped but the ride never made it to the server -- a
        // save that timed out, or the app being killed mid-upload. This used to
        // clear the session pointer and leave the samples orphaned in storage:
        // the ride was still on the phone but nothing could reach it. Surface
        // it instead so it can be saved.
        setSessionId(active.sessionId);
        setStartedAt(active.startedAt);
        setSamples(buffered);
        setUnsavedRide({ sessionId: active.sessionId, sampleCount: buffered.length });
      } else if (buffered.length > 0) {
        // Samples with no session behind them at all: a ride stranded by an
        // earlier build, which cleared the pointer here and left the data
        // unreachable. It can still be saved, just under a new session.
        setUnsavedRide({ sessionId: null, sampleCount: buffered.length });
        setSamples(buffered);
      } else if (active) {
        await setActiveSession(null);
      }
    })().catch((err) => console.warn("failed to restore tracking state", err));
  }, []);

  useEffect(() => {
    if (!isTracking) return;
    const interval = setInterval(() => {
      readBufferedSamples()
        .then(setSamples)
        .catch((err) => console.warn("failed to read sample buffer", err));
    }, BREADCRUMB_POLL_MS);
    return () => clearInterval(interval);
  }, [isTracking]);

  const startBarometer = useCallback(async () => {
    if (!(await Barometer.isAvailableAsync())) return;
    Barometer.setUpdateInterval(1000);
    barometerSubscription.current = Barometer.addListener(({ pressure, relativeAltitude }) => {
      if (relativeAltitude != null) {
        recordBarometerAltitude(relativeAltitude);
        return;
      }
      const absoluteAltitudeM = pressureToAltitudeM(pressure);
      if (baselinePressureAltitudeM.current == null) {
        baselinePressureAltitudeM.current = absoluteAltitudeM;
      }
      recordBarometerAltitude(absoluteAltitudeM - baselinePressureAltitudeM.current);
    });
  }, []);

  // Takes no session id: a ride begins entirely on the phone. Requiring a
  // server round trip here meant a weak signal at the trailhead blocked the
  // ride outright, and a timed-out retry could not tell "the server never got
  // it" from "the server got it and the reply was lost" -- so each retry left
  // another empty session behind. The session is created when the ride is
  // saved instead, by which point there is something worth saving.
  const start = useCallback(
    async () => {
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (foreground.status !== "granted") throw new Error("Location permission denied");

      // Without this, Android stops delivering fixes as soon as the screen
      // locks -- which is what made rides depend on keeping the app open.
      const background = await Location.requestBackgroundPermissionsAsync();
      if (background.status !== "granted") {
        throw new Error(
          'Background location permission denied. Grant "Allow all the time" in Settings so tracking continues with the screen off.',
        );
      }

      resetTrackingState();
      baselinePressureAltitudeM.current = null;
      await clearBufferedSamples();
      setSamples([]);

      await startBarometer();
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, CRUISE_OPTIONS);

      const rideStartedAt = new Date().toISOString();
      await setActiveSession({ sessionId: null, startedAt: rideStartedAt });

      setSessionId(null);
      setStartedAt(rideStartedAt);
      setIsTracking(true);
    },
    [startBarometer],
  );

  const stop = useCallback(async (): Promise<TrackedSample[]> => {
    barometerSubscription.current?.remove();
    barometerSubscription.current = null;

    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }

    const finalSamples = await readBufferedSamples();
    setSamples(finalSamples);
    setIsTracking(false);
    return finalSamples;
  }, []);

  // Only called once a ride has been saved -- keeping the buffer and the
  // active session until then means a failed upload can be retried instead of
  // losing the ride.
  // Ties a recovered ride to the session it is being uploaded under, and
  // persists that. Without it every retry minted a fresh session, so a save
  // that timed out after the server had already finished would fold the same
  // ride into the model a second time.
  // Keeps the original start time: this used to stamp `now()`, which was
  // harmless when the field was only a note to ourselves, but it is now the
  // value sent to the server and would relabel a recovered ride as having
  // started at the moment it was finally saved.
  const adoptSession = useCallback(async (id: number) => {
    const existing = await getActiveSession();
    await setActiveSession({
      sessionId: id,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
    });
    setSessionId(id);
    setUnsavedRide((ride) => (ride ? { ...ride, sessionId: id } : ride));
  }, []);

  const discardBuffered = useCallback(async () => {
    await clearBufferedSamples();
    await setActiveSession(null);
    setSessionId(null);
    setStartedAt(null);
    setSamples([]);
    setUnsavedRide(null);
  }, []);

  return {
    isTracking,
    sessionId,
    startedAt,
    samples,
    unsavedRide,
    start,
    stop,
    adoptSession,
    discardBuffered,
  };
}
