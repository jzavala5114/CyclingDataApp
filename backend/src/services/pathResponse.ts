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
import type { Direction, Segment } from "../types/index.js";

// What GET /segments/path sends: the path a press-and-hold selection grows
// along, as the phone draws it and as its card adds it up.
//
// `pieces` and `spans` describe only what this request adds, and their `atM`
// counts from its own start: a request extending a selection is appended by the
// phone to what it already holds.
//
// Where this differs from the design's first draft (context/session.md), and
// why: the profile is `spans`, the exact stretches the map colours (15m between
// buckets, shorter where a line starts or stops), rather than samples every
// 15m, so no stretch is resampled; its heights are relative to the path's start
// and come from summing the slopes, never from the bucket means, whose levels
// differ ride to ride; and a piece with no data is drawn on the travelled side
// of its street like the lines either side of it, not on the centreline, so the
// highlight does not jog 4m sideways at every gap.

// How much of each branch at a fork is sent, for the phone to mark.
const BRANCH_STUB_M = 30;

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
  spans: Array<
    PathSpan & {
      /** The height at the span's start, in metres above the path's start: the sum of the slopes before it. */
      heightM: number;
      /** The height gained over the span, negative for a descent. */
      riseM: number;
      /** The rides behind the span's numbers, as on its piece. */
      rides: number;
    }
  >;
  lengthM: number;
  stop: {
    reason: PathEnd;
    /** Where along the path it stops. */
    atM: number;
    /** How far past that, on ground with no data, the reason lies: a fork, a dead end or a limit. */
    aheadM: number;
    /**
     * At a fork: the lines the rider can hold to go on, with their data and
     * their first BRANCH_STUB_M, drawn on their travelled side in the order
     * travelled, so the phone can mark a branch it has no line for.
     */
    branches: Array<{
      segmentId: number;
      direction: Direction;
      streetName: string | null;
      source: Source;
      geometry: GeoJSON.LineString;
    }>;
  };
  /** The colour bands, so the phone labels them without a copy of the table. */
  bands: Array<{ maxSlopePct: number | null; color: string }>;
}

// A stretch of a line on its own side of the street, in the order travelled.
// offsetTravelSlice is the map's own slicing and gives the geometry's forward
// order, so a piece of a drawn line sits exactly on it.
function travelledSlice(segment: Segment, direction: Direction, fromM: number, toM: number): GeoJSON.LineString {
  const sliced = offsetTravelSlice(segment, direction, fromM, toM);
  return direction === "forward" ? sliced : { type: "LineString", coordinates: [...sliced.coordinates].reverse() };
}

export function pathResponse(
  graph: PathGraph,
  pieces: readonly PathPiece[],
  stop: { reason: PathEnd; branches: readonly Candidate[]; aheadM: number },
  lines: ReadonlyMap<string, LineData>,
  rides: ReadonlyMap<string, LineRides>,
): PathResponse {
  const responsePieces = pieces.map((piece) => {
    const segment = graph.segments.get(piece.segmentId)!;
    const geometry = travelledSlice(segment, piece.direction, piece.fromM, piece.toM);
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
  let heightM = 0;
  const spans = pathSpans(graph, pieces, lines).map((span) => {
    const riseM = (span.slopePct * span.lengthM) / 100;
    const withHeight = { ...span, heightM, riseM, rides: responsePieces[span.piece]!.rides };
    heightM += riseM;
    return withHeight;
  });
  return {
    pieces: responsePieces,
    spans,
    lengthM,
    stop: {
      reason: stop.reason,
      atM: lengthM,
      aheadM: stop.aheadM,
      branches: stop.branches.map((b) => {
        const segment = graph.segments.get(b.segmentId)!;
        return {
          segmentId: b.segmentId,
          direction: b.direction,
          streetName: b.streetName,
          source: b.source,
          geometry: travelledSlice(segment, b.direction, 0, Math.min(BRANCH_STUB_M, segment.lengthM)),
        };
      }),
    },
    bands: slopeBands(),
  };
}
