import { offsetTravelSlice, slopeBands } from "./gradientBuilder.js";
import type { LineRides } from "./pathData.js";
import {
  lineKey,
  oppositeOf,
  pathSpans,
  type Candidate,
  type LineData,
  type PathGraph,
  type PathPiece,
  type PathSpan,
  type PieceRule,
  type Source,
  type StopReason,
} from "./pathGrowth.js";
import type { Direction } from "../types/index.js";

// What GET /segments/path sends: the path a press-and-hold selection grows
// along, as the phone draws it and as its card adds it up.
//
// `pieces` and `spans` describe only what this request adds, and their `atM`
// counts from its own start: a request extending a selection is appended by the
// phone to what it already holds.

/** Why the path ends: growth's own reasons, or a request's. */
export type PathEnd =
  | StopReason
  // A request that asked only to reach a point, and did.
  | "joined"
  // A request that asked to reach a point with no way there within the limit.
  | "unreachable";

export interface PathResponse {
  pieces: Array<{
    segmentId: number;
    direction: Direction;
    streetName: string | null;
    /** Metres along the segment in its direction of travel. */
    fromM: number;
    toM: number;
    /** Where the piece starts along the path. */
    atM: number;
    lengthM: number;
    source: Source;
    rule: PieceRule | null;
    /** The stretch drawn on the line's own side of the street, in the order it is travelled. */
    geometry: GeoJSON.LineString;
    /** The rides behind the piece's numbers: its own line's, or for `twin` the other direction's. */
    rides: number;
    lastRiddenAt: string | null;
  }>;
  spans: PathSpan[];
  lengthM: number;
  stop: {
    reason: PathEnd;
    /** Where along the path it stops. */
    atM: number;
    /** At a fork: the lines the rider can hold to go on. */
    branches: Array<{ segmentId: number; direction: Direction; streetName: string | null }>;
  };
  /** The colour bands, so the phone labels them without a copy of the table. */
  bands: Array<{ maxSlopePct: number | null; color: string }>;
}

export function pathResponse(
  graph: PathGraph,
  pieces: readonly PathPiece[],
  reason: PathEnd,
  branches: readonly Candidate[],
  lines: ReadonlyMap<string, LineData>,
  rides: ReadonlyMap<string, LineRides>,
): PathResponse {
  const responsePieces = pieces.map((piece) => {
    const segment = graph.segments.get(piece.segmentId)!;
    // The map's own slice of this line, so the highlight sits exactly on the
    // drawn line. offsetTravelSlice gives it in the geometry's forward order.
    const sliced = offsetTravelSlice(segment, piece.direction, piece.fromM, piece.toM);
    const geometry: GeoJSON.LineString =
      piece.direction === "forward" ? sliced : { type: "LineString", coordinates: [...sliced.coordinates].reverse() };
    const behind =
      piece.source === "line"
        ? rides.get(lineKey(piece))
        : piece.source === "twin"
          ? rides.get(lineKey({ segmentId: piece.segmentId, direction: oppositeOf(piece.direction) }))
          : undefined;
    return {
      segmentId: piece.segmentId,
      direction: piece.direction,
      streetName: segment.streetName,
      fromM: piece.fromM,
      toM: piece.toM,
      atM: piece.atM,
      lengthM: piece.toM - piece.fromM,
      source: piece.source,
      rule: piece.rule,
      geometry,
      rides: behind?.rides ?? 0,
      lastRiddenAt: behind ? behind.lastRiddenAt.toISOString() : null,
    };
  });
  const last = responsePieces[responsePieces.length - 1];
  const lengthM = last ? last.atM + last.lengthM : 0;
  return {
    pieces: responsePieces,
    spans: pathSpans(graph, pieces, lines),
    lengthM,
    stop: {
      reason,
      atM: lengthM,
      branches: branches.map((b) => ({ segmentId: b.segmentId, direction: b.direction, streetName: b.streetName })),
    },
    bands: slopeBands(),
  };
}
