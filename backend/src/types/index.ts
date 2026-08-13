export type Direction = "forward" | "backward";

export interface SessionSample {
  id: number;
  sessionId: number;
  recordedAt: string;
  lat: number;
  lon: number;
  elevationM: number;
  headingDeg: number | null;
  speedMps: number | null;
  accuracyM: number | null;
}

export interface Segment {
  id: number;
  osmWayId: number;
  streetName: string | null;
  startNodeId: number;
  endNodeId: number;
  geom: GeoJSON.LineString;
  lengthM: number;
  bearingDeg: number;
}

export interface MatchedRun {
  segmentId: number;
  direction: Direction;
  samples: SessionSample[];
}

export interface ElevationBucket {
  segmentId: number;
  direction: Direction;
  distanceM: number;
  elevationM: number;
  sampleCount: number;
}
