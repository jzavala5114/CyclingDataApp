import { useCallback, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
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

// Poll the barometer far faster than fixes arrive and average the readings
// (see `drainBarometerRelativeM` in backgroundLocationTask.ts). At one reading
// per fix there was nothing to average and the single value carried its full
// noise into the elevation series; at 5Hz a 1-4s fix interval collects 5-20
// readings, cutting noise by roughly sqrt(n).
//
// Android 12 caps every sensor at 200Hz, so 5Hz is far inside the limit, and a
// pressure sensor costs almost nothing next to the GPS this app already runs.
// The interval is a request, not a guarantee -- the OS may deliver faster or
// slower, which is why the accumulator counts readings instead of assuming a
// rate.
const BAROMETER_INTERVAL_MS = 200;

// Tag for the screen lock below. Named rather than defaulted so it cannot be
// released by anything else that happens to call deactivateKeepAwake().
const KEEP_AWAKE_TAG = "cyclingdataapp-ride";

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

  // The barometer's lifetime is tied to `isTracking` rather than to `start()`.
  // It used to be subscribed from `start()` alone, which meant the recovery
  // path above -- Android tearing down the JS context mid-ride and the effect
  // resuming the session -- restored the ride but never restarted the sensor,
  // leaving the rest of that ride on GPS altitude with nothing to say so. Any
  // route into a tracking state now subscribes, because there is only one.
  //
  // On resume the relative baseline is re-established wherever the rider
  // currently is, and `elevationFor` re-anchors it to the next GPS altitude, so
  // the series stays continuous across the restart to within GPS accuracy
  // instead of stepping.
  useEffect(() => {
    if (!isTracking) return;

    let cancelled = false;
    let subscription: ReturnType<typeof Barometer.addListener> | null = null;
    baselinePressureAltitudeM.current = null;

    (async () => {
      if (!(await Barometer.isAvailableAsync())) return;
      if (cancelled) return; // stopped while we were awaiting availability
      Barometer.setUpdateInterval(BAROMETER_INTERVAL_MS);
      subscription = Barometer.addListener(({ pressure, relativeAltitude }) => {
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
    })().catch((err) => console.warn("failed to start barometer", err));

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [isTracking]);

  // Hold the screen on for the length of the ride. `expo-sensors` unregisters
  // the barometer itself when the activity backgrounds -- SensorProxy.kt has
  // `OnActivityEntersBackground -> stopObserving()` -- and after
  // BAROMETER_STALE_AFTER_MS the task falls back to GPS altitude, which is
  // about twice as noisy per bucket and can shift a segment a whole colour
  // band. Keeping the activity in the foreground keeps the better sensor.
  //
  // This only defeats the *idle timeout*. Pressing the power button still
  // backgrounds the activity and still costs the barometer; it comes back by
  // itself on the next wake, so the loss is bounded by how long the screen
  // stays dark. Making screen-off riding as good as screen-on needs the sensor
  // held against the foreground service instead of the activity, which is a
  // native module.
  useEffect(() => {
    if (!isTracking) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch((err) =>
      console.warn("failed to keep the screen awake", err),
    );
    return () => {
      // Rejects if the activity is already gone, which is exactly when we no
      // longer care -- the lock dies with it.
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [isTracking]);

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
      await clearBufferedSamples();
      setSamples([]);

      // The barometer is subscribed by the effect above, off `isTracking`.
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, CRUISE_OPTIONS);

      const rideStartedAt = new Date().toISOString();
      await setActiveSession({ sessionId: null, startedAt: rideStartedAt });

      setSessionId(null);
      setStartedAt(rideStartedAt);
      setIsTracking(true);
    },
    [],
  );

  const stop = useCallback(async (): Promise<TrackedSample[]> => {
    // The barometer subscription and the screen lock are released by the
    // effects above when `isTracking` goes false at the end of this function.
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
