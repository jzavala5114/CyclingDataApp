export type Direction = "forward" | "backward";

export interface TrackedSample {
  recordedAt: string;
  lat: number;
  lon: number;
  elevationM: number;
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
