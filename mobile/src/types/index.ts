export type Direction = "forward" | "backward";

// Which sensor produced `elevationM`. The barometer is roughly 100x more
// precise vertically than GPS altitude, and the phone silently swaps between
// them mid-ride, so a height is not interpretable without knowing which one it
// came from. See elevationFor() in services/backgroundLocationTask.ts.
export type ElevationSource = "barometer" | "gps";

export interface TrackedSample {
  recordedAt: string;
  lat: number;
  lon: number;
  elevationM: number;
  elevationSource: ElevationSource;
  // The phone's own estimate of how wrong its *GPS altitude* is, in metres --
  // nothing to do with `accuracyM`, which is horizontal. Recorded on barometer
  // samples too: there it says how bad the fallback would have been.
  altitudeAccuracyM: number | null;
  headingDeg: number | null;
  speedMps: number | null;
  accuracyM: number | null;
}

export interface DirectionalGradientLine {
  direction: Direction;
  geometry: GeoJSON.LineString;
  colorStops: Array<{ distanceFraction: number; color: string }>;
}

export interface SegmentWithGradients {
  id: number;
  streetName: string | null;
  geom: GeoJSON.LineString;
  lengthM: number;
  directionalLines: DirectionalGradientLine[];
}
