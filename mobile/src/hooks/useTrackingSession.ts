import { useCallback, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { Barometer } from "expo-sensors";
import * as RideBarometer from "../../modules/ride-barometer";
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
import { altitudeFromPressureHpa } from "../services/barometerWindow";
import {
  HEALTH_WINDOW_FIXES,
  recentBarometerShare,
  shouldAbandonNative,
  type BarometerHealth,
} from "../services/barometerHealth";
import type { TrackedSample } from "../types";

// Poll the barometer far faster than fixes arrive and average the readings. At
// one reading per fix there was nothing to average and the single value carried
// its full noise into the elevation series; at 5Hz a 1-4s fix interval collects
// 5-20 readings, cutting noise by roughly sqrt(n).
//
// Android 12 caps every sensor at 200Hz, so 5Hz is far inside the limit, and a
// pressure sensor costs almost nothing next to the GPS this app already runs.
// The interval is a request, not a guarantee -- the OS may deliver faster or
// slower, which is why both paths count readings instead of assuming a rate.
const BAROMETER_INTERVAL_MS = 200;

// How often to re-read the native module's counters while a ride is running.
// Matched to the breadcrumb poll because they are both "refresh what the screen
// shows", and a second interval timer for one line of text is not worth it.
const BAROMETER_POLL_MS = 5000;

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
  const [barometer, setBarometer] = useState<BarometerHealth | null>(null);
  // One way, reset when a ride ends. Set by the watchdog below when the native
  // module is registered but no fix is coming out barometric, which is the one
  // state that used to cost a whole ride silently.
  const [nativeAbandoned, setNativeAbandoned] = useState(false);

  // The watchdog judges on the fixes actually being stored, and it runs on an
  // interval. Holding them in a ref rather than as a dependency keeps that
  // interval from being torn down and rebuilt every two seconds as the
  // breadcrumb updates.
  const samplesRef = useRef<TrackedSample[]>([]);
  samplesRef.current = samples;

  // Only the `expo-sensors` fallback needs this. On Android the native module
  // hands over raw pressure and the baseline is taken in
  // backgroundLocationTask.ts, where the GPS anchor it pairs with already lives.
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
  //
  // TWO PATHS, AND THE ORDER MATTERS. The native module is tried first because
  // it is the one that survives a locked screen: it registers the sensor
  // against the process, where `expo-sensors` registers it against the activity
  // and tears it down in `OnActivityEntersBackground` (SensorProxy.kt:99). Only
  // if the native module is not in this build, or the phone has no pressure
  // sensor, does `expo-sensors` get subscribed -- and the two are never
  // subscribed at once, because two listeners on one sensor is two sources of
  // truth for the same height.
  useEffect(() => {
    if (!isTracking) return;

    let cancelled = false;
    let subscription: ReturnType<typeof Barometer.addListener> | null = null;
    baselinePressureAltitudeM.current = null;
    setBarometer(null);

    (async () => {
      // A stop before every start, awaited. `start` only resets its counters
      // and clears its ring when it was not already registered, so a ride
      // beginning while a previous registration was still live would inherit
      // the last ride's reading count and start time, and report a healthy
      // rate averaged across both. The cleanup below is fire-and-forget, so
      // this is the one that is guaranteed to have landed.
      await RideBarometer.stopAsync();
      if (cancelled) return;

      // `nativeAbandoned` means the watchdog already caught this module
      // registering and then producing nothing. Skipping straight to
      // `expo-sensors` is the whole point of that signal.
      const usingNative = nativeAbandoned
        ? false
        : await RideBarometer.startAsync(BAROMETER_INTERVAL_MS);
      if (cancelled) {
        // The ride stopped while this await was in flight. The cleanup below
        // has already run and called `stopAsync` on a sensor that was not yet
        // registered, so without this the listener outlives the ride.
        if (usingNative) await RideBarometer.stopAsync();
        return;
      }
      if (usingNative) {
        const status = await RideBarometer.getStatusAsync();
        if (cancelled) return;
        setBarometer({
          path: "native",
          registered: true,
          hz: null,
          readings: 0,
          repaired: 0,
          wakeUp: status?.wakeUp ?? false,
          usedShare: null,
        });
        return;
      }

      // Fallback: iOS, Expo Go, or a phone with no pressure sensor. iOS reports
      // `relativeAltitude` (metres from where tracking started) directly; on
      // Android `expo-sensors` gives raw pressure, so the same relative measure
      // has to be derived here. Either way this listener stops at the next
      // screen lock, which is the behaviour the native path exists to replace.
      const available = await Barometer.isAvailableAsync();
      if (cancelled) return; // stopped while we were awaiting availability
      if (!available) {
        setBarometer({
          path: "none", registered: false, hz: null, readings: null,
          repaired: null, wakeUp: false, usedShare: null,
        });
        return;
      }
      Barometer.setUpdateInterval(BAROMETER_INTERVAL_MS);
      subscription = Barometer.addListener(({ pressure, relativeAltitude }) => {
        if (relativeAltitude != null) {
          recordBarometerAltitude(relativeAltitude);
          return;
        }
        const absoluteAltitudeM = altitudeFromPressureHpa(pressure);
        if (baselinePressureAltitudeM.current == null) {
          baselinePressureAltitudeM.current = absoluteAltitudeM;
        }
        recordBarometerAltitude(absoluteAltitudeM - baselinePressureAltitudeM.current);
      });
      setBarometer({
        path: "sensors", registered: false, hz: null, readings: null,
        repaired: null, wakeUp: false, usedShare: null,
      });
    })().catch((err) => console.warn("failed to start barometer", err));

    return () => {
      cancelled = true;
      subscription?.remove();
      // Unconditional, and harmless when the native path was never started --
      // the facade answers false rather than throwing. Conditioning it on
      // `usingNative` would leave the sensor registered in the one case that
      // matters, where `startAsync` succeeded after the effect was torn down.
      RideBarometer.stopAsync().catch(() => {});
    };
  }, [isTracking, nativeAbandoned]);

  // A ride that gave up on the native module gets a clean slate at the next
  // one: the give-up is about this sensor on this run, not a permanent verdict
  // on the phone.
  useEffect(() => {
    if (!isTracking) setNativeAbandoned(false);
  }, [isTracking]);

  // Re-read the native counters while the ride runs, and WATCH THE OUTPUT.
  //
  // Two jobs. The first is the status line on the map, which is the only
  // instrument available during the one measurement that matters -- a ride
  // taken with the screen deliberately locked -- because there is no debugger
  // attached to a bicycle.
  //
  // The second is the watchdog, and it is the more important of the two.
  // `startAsync` returning true means Android accepted the sensor
  // registration; it does not mean a reading ever arrives. Without this, a
  // sensor that registered and then stayed quiet cost the ride its barometer
  // from end to end, because `expo-sensors` was never subscribed -- a
  // regression against the behaviour this change was meant to improve on. The
  // test is run against the fixes actually being stored rather than against the
  // native module's own counters, because a sensor whose clock disagrees with
  // the phone's delivers thousands of readings that land in no fix's window.
  useEffect(() => {
    if (!isTracking || nativeAbandoned) return;
    let stopped = false;
    const read = async () => {
      const counters = await RideBarometer.getCountersAsync();
      if (stopped || counters == null) return;

      const recentSources = samplesRef.current
        .slice(-HEALTH_WINDOW_FIXES)
        .map((sample) => sample.elevationSource);
      const elapsedMs = counters.startedAtMs == null ? NaN : Date.now() - counters.startedAtMs;

      if (counters.registered && shouldAbandonNative(elapsedMs, recentSources)) {
        // One way, and it takes effect by re-running the effect above, which
        // skips `startAsync` and subscribes `expo-sensors` instead.
        console.warn("ride-barometer: no barometric fixes, falling back to expo-sensors");
        setNativeAbandoned(true);
        return;
      }

      const elapsedS = elapsedMs / 1000;
      setBarometer({
        path: "native",
        registered: counters.registered,
        // Guarded against a zero elapsed time on the first read, which would
        // otherwise show Infinity Hz for five seconds at the start of a ride.
        hz: Number.isFinite(elapsedS) && elapsedS >= 1 ? counters.delivered / elapsedS : null,
        readings: counters.delivered,
        repaired: counters.repaired,
        wakeUp: counters.wakeUp,
        usedShare: recentBarometerShare(recentSources),
      });
    };
    read().catch(() => {});
    const interval = setInterval(() => void read().catch(() => {}), BAROMETER_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [isTracking, nativeAbandoned]);

  // Hold the screen on for the length of the ride.
  //
  // ITS ORIGINAL REASON IS GONE. This was here because `expo-sensors`
  // unregisters the barometer when the activity backgrounds, so keeping the
  // activity in the foreground was the only way to keep the better sensor. The
  // native module now holds the sensor against the process instead, which is
  // what the old comment here said would be needed, so on Android this no
  // longer protects the elevation data at all.
  //
  // Kept anyway, for a smaller reason: a phone on a handlebar mount is being
  // looked at, and a ride that blanks the map every thirty seconds is worse to
  // use. It costs battery for a benefit that is now only cosmetic, so it is a
  // fair thing to drop -- that is Julian's call, not a silent one, and the test
  // ride is the wrong time to change two things at once.
  //
  // On the `expo-sensors` fallback path (iOS, Expo Go) the original reason
  // still holds in full.
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
    barometer,
    start,
    stop,
    adoptSession,
    discardBuffered,
  };
}
