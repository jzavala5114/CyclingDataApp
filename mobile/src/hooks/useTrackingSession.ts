import { useCallback, useRef, useState } from "react";
import * as Location from "expo-location";
import { Barometer } from "expo-sensors";
import type { TrackedSample } from "../types";

// iOS's Barometer reports `relativeAltitude` (meters, relative to wherever
// tracking started) directly. Android's CMBarometer-equivalent only exposes
// raw `pressure` (hPa), so there's no relativeAltitude there -- this hook
// falls back to GPS-reported altitude on Android. Both are noisy; averaging
// across many sessions in the backend (see elevationAggregator) is what's
// meant to make the data usable, not any single session's readings.
const SEA_LEVEL_HPA = 1013.25;

function pressureToAltitudeM(pressureHpa: number): number {
  return 44330 * (1 - Math.pow(pressureHpa / SEA_LEVEL_HPA, 1 / 5.255));
}

export function useTrackingSession() {
  const [isTracking, setIsTracking] = useState(false);
  const [samples, setSamples] = useState<TrackedSample[]>([]);

  const baselineAltitudeM = useRef<number | null>(null);
  const latestBarometerAltitudeM = useRef<number | null>(null);
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);
  const barometerSubscription = useRef<ReturnType<typeof Barometer.addListener> | null>(null);

  const start = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") throw new Error("location permission denied");

    baselineAltitudeM.current = null;
    latestBarometerAltitudeM.current = null;
    setSamples([]);

    if (await Barometer.isAvailableAsync()) {
      Barometer.setUpdateInterval(1000);
      barometerSubscription.current = Barometer.addListener(({ pressure, relativeAltitude }) => {
        if (relativeAltitude != null) {
          latestBarometerAltitudeM.current = relativeAltitude;
          return;
        }
        const absoluteAltitudeM = pressureToAltitudeM(pressure);
        if (baselineAltitudeM.current == null) baselineAltitudeM.current = absoluteAltitudeM;
        latestBarometerAltitudeM.current = absoluteAltitudeM - baselineAltitudeM.current;
      });
    }

    locationSubscription.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 2,
      },
      (location) => {
        const elevationM = latestBarometerAltitudeM.current ?? location.coords.altitude ?? 0;
        const sample: TrackedSample = {
          recordedAt: new Date(location.timestamp).toISOString(),
          lat: location.coords.latitude,
          lon: location.coords.longitude,
          elevationM,
          headingDeg: location.coords.heading,
          speedMps: location.coords.speed,
          accuracyM: location.coords.accuracy,
        };
        setSamples((prev) => [...prev, sample]);
      },
    );

    setIsTracking(true);
  }, []);

  const stop = useCallback((): TrackedSample[] => {
    locationSubscription.current?.remove();
    locationSubscription.current = null;
    barometerSubscription.current?.remove();
    barometerSubscription.current = null;
    setIsTracking(false);
    return samples;
  }, [samples]);

  return { isTracking, samples, start, stop };
}
