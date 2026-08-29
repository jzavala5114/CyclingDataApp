export type Direction = "forward" | "backward";

// Which sensor produced a sample's elevation. Null for rows recorded before
// the phone started reporting it -- those predate the column and cannot be
// classified after the fact, only inferred from their noise.
export type ElevationSource = "barometer" | "gps";

export interface SessionSample {
  id: number;
  sessionId: number;
  recordedAt: string;
  lat: number;
  lon: number;
  elevationM: number;
  elevationSource: ElevationSource | null;
  // Vertical accuracy in metres. Unrelated to accuracyM, which is horizontal.
  altitudeAccuracyM: number | null;
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
