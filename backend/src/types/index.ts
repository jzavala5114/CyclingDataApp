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

export type SegmentKind = "road" | "cycleway" | "footway";

export interface Segment {
  id: number;
  osmWayId: number;
  kind: SegmentKind;
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

// The stretch of a segment that has been ridden in a given direction, in
// metres along the direction of travel, unioned across every ride.
export interface SegmentCoverage {
  segmentId: number;
  direction: Direction;
  coveredFromM: number;
  coveredToM: number;
}
