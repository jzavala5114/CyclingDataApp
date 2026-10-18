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

// GET /segments/path: the path a press-and-hold selection grows along. The
// server's backend/src/services/pathResponse.ts says what every field means;
// these mirror it.

/** What a stretch of a path is measured from: its own line, the other direction's line (slopes negated), or nothing. */
export type PathSource = "line" | "twin" | "none";

/** How a piece's segment joined the path. history, name, turn and only are the fork rule's steps. */
export type PathRule = "start" | "connect" | "history" | "name" | "turn" | "only" | "least";

/** Why a path ends: growth's own reasons, then the two a connection gives. */
export type PathEnd = "end" | "fork" | "gap" | "loop" | "limit" | "joined" | "unreachable";

export interface PathPiece {
  segmentId: number;
  direction: Direction;
  streetName: string | null;
  /** Metres along the segment in its direction of travel. */
  fromM: number;
  toM: number;
  /** Where the piece starts along the path. */
  atM: number;
  lengthM: number;
  source: PathSource;
  rule: PathRule | null;
  /** On the line's own side of the street, in the order travelled. */
  geometry: GeoJSON.LineString;
  rides: number;
  lastRiddenAt: string | null;
}

/** One stretch of the path at one slope, exactly as the map colours it. */
export interface PathSpan {
  atM: number;
  lengthM: number;
  slopePct: number;
  color: string;
  source: PathSource;
  /** The index of the piece it lies on. */
  piece: number;
  /** Metres above the path's start where the span begins. */
  heightM: number;
  riseM: number;
  rides: number;
}

/** A line the rider can hold at a fork to go on: its first 30m, on its travelled side. */
export interface PathBranch {
  segmentId: number;
  direction: Direction;
  streetName: string | null;
  source: PathSource;
  geometry: GeoJSON.LineString;
}

export interface PathStop {
  reason: PathEnd;
  atM: number;
  /** How far past `atM`, on ground nobody measured, the reason lies. */
  aheadM: number;
  branches: PathBranch[];
}

/** A colour band: slopes up to `maxSlopePct` (null for the open-ended top band) get `color`. */
export interface SlopeBand {
  maxSlopePct: number | null;
  color: string;
}

export interface PathResponse {
  pieces: PathPiece[];
  spans: PathSpan[];
  lengthM: number;
  stop: PathStop;
  bands: SlopeBand[];
}
