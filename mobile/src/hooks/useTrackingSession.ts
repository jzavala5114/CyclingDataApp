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

export function useTrackingSession() {
  const [isTracking, setIsTracking] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [samples, setSamples] = useState<TrackedSample[]>([]);

  const baselinePressureAltitudeM = useRef<number | null>(null);
  const barometerSubscription = useRef<ReturnType<typeof Barometer.addListener> | null>(null);

  // Reconcile with whatever the OS is still doing from a previous launch.
  useEffect(() => {
    (async () => {
      const [active, taskRunning] = await Promise.all([
        getActiveSession(),
        Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME),
      ]);

      if (active && taskRunning) {
        // A ride outlived the app being torn down -- resume it.
        setSessionId(active.sessionId);
        setIsTracking(true);
        setSamples(await readBufferedSamples());
      } else if (taskRunning) {
        // Updates running with no ride behind them: stop rather than let them
        // drain the battery with no UI to turn them off.
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
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

  const start = useCallback(
    async (newSessionId: number) => {
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
      await setActiveSession({ sessionId: newSessionId, startedAt: new Date().toISOString() });

      setSessionId(newSessionId);
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
  const discardBuffered = useCallback(async () => {
    await clearBufferedSamples();
    await setActiveSession(null);
    setSessionId(null);
    setSamples([]);
  }, []);

  return { isTracking, sessionId, samples, start, stop, discardBuffered };
}
