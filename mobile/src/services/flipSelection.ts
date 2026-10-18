import type { Position } from "geojson";
import type { PathPoint, PathRequest } from "./api";
import { appendPath, fromResponse, type Selection } from "./pathSelection";
import type { Direction, PathResponse } from "../types";

// The flip button: the same streets ridden the other way, each on its other
// direction's line, in reverse order. The phone cannot build it alone, since
// the other direction has its own rides and its own slopes, which only the
// server has. So it asks for connections along the twin lines (grow=false),
// and checks every answer runs on exactly the lines it asked for: a connection
// is the cheapest way between two points, which beside a winding trail can be
// a straight road. A chunk that comes back on other streets is split in two
// and asked again, down to a single line, whose connection is always that
// line.
//
// Each chunk is asked from the start of its first line (atM 0) to the start of
// the line after it (toAtM 0): the start of a line in its direction of travel
// is the one place on it the phone can name without the segment's length,
// which the answer does not carry. Only the two ends of the whole flip are
// points inside a line, and they are named by coordinate, so the server
// measures them as it measures a press.

/** Under GET /segments/path's 2,000m cap on a connection (MAX_CONNECT_M), with room to spare. */
export const FLIP_CHUNK_M = 1800;

interface TwinLine {
  segmentId: number;
  direction: Direction;
  lengthM: number;
  /** Where the line starts in the flipped selection: the original's piece end. */
  start: Position;
}

const opposite = (d: Direction): Direction => (d === "forward" ? "backward" : "forward");

// The flipped selection's lines in order: the selection's pieces reversed,
// each on the other direction, pieces of one segment merged into one line.
export function twinLines(selection: Selection): TwinLine[] {
  const lines: TwinLine[] = [];
  for (let i = selection.pieces.length - 1; i >= 0; i--) {
    const piece = selection.pieces[i]!;
    if (piece.lengthM <= 0) continue;
    const coordinates = piece.geometry.coordinates;
    const last = lines[lines.length - 1];
    if (last && last.segmentId === piece.segmentId) {
      last.lengthM += piece.lengthM;
      continue;
    }
    lines.push({
      segmentId: piece.segmentId,
      direction: opposite(piece.direction),
      lengthM: piece.lengthM,
      start: coordinates[coordinates.length - 1]!,
    });
  }
  return lines;
}

/** The lines an answer runs on, in order, each once in a row, ignoring the zero-length piece a connection can end with. */
function answerLines(response: PathResponse): string[] {
  const keys: string[] = [];
  for (const piece of response.pieces) {
    if (piece.lengthM <= 0) continue;
    const key = `${piece.segmentId}:${piece.direction}`;
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

// Splits the lines into chunks of at most FLIP_CHUNK_M; a single line longer
// than that is a chunk of its own.
export function chunkLines(lines: readonly TwinLine[]): TwinLine[][] {
  const chunks: TwinLine[][] = [];
  let current: TwinLine[] = [];
  let currentM = 0;
  for (const line of lines) {
    if (current.length > 0 && currentM + line.lengthM > FLIP_CHUNK_M) {
      chunks.push(current);
      current = [];
      currentM = 0;
    }
    current.push(line);
    currentM += line.lengthM;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export class FlipFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlipFailed";
  }
}

export interface FlipResult {
  selection: Selection;
  /** How many requests it took: one per chunk when nothing came back on other streets. */
  requests: number;
}

// `end` is where the original selection ends, the flip's start; `start` where
// it starts, the flip's end. Both are coordinates on the original lines,
// which the server projects onto the centreline like any press.
export async function flipSelection(
  selection: Selection,
  fetchPath: (request: PathRequest) => Promise<PathResponse>,
): Promise<FlipResult> {
  const lines = twinLines(selection);
  if (lines.length === 0) throw new FlipFailed("nothing to flip");
  const firstCoordinates = selection.pieces[0]!.geometry.coordinates;
  const flipEnd = firstCoordinates[0]!;
  let requests = 0;

  // Asks for lines[from..to) as one connection, splitting on a detour.
  const ask = async (from: number, to: number): Promise<PathResponse[]> => {
    const first = lines[from]!;
    const fromPoint: PathPoint =
      from === 0
        ? { segmentId: first.segmentId, direction: first.direction, lon: first.start[0]!, lat: first.start[1]! }
        : { segmentId: first.segmentId, direction: first.direction, lon: first.start[0]!, lat: first.start[1]!, atM: 0 };
    const next = lines[to];
    const toPoint: PathPoint = next
      ? { segmentId: next.segmentId, direction: next.direction, lon: next.start[0]!, lat: next.start[1]!, atM: 0 }
      : { segmentId: lines[to - 1]!.segmentId, direction: lines[to - 1]!.direction, lon: flipEnd[0]!, lat: flipEnd[1]! };
    requests += 1;
    const response = await fetchPath({ from: fromPoint, to: toPoint, grow: false });
    const wanted = lines.slice(from, to).map((l) => `${l.segmentId}:${l.direction}`);
    const got = answerLines(response);
    const followed = response.stop.reason === "joined" && got.length === wanted.length && got.every((k, i) => k === wanted[i]);
    if (followed) return [response];
    if (to - from === 1) {
      throw new FlipFailed(
        response.stop.reason === "unreachable"
          ? `no way along ${wanted[0]} the other way`
          : `the other way along ${wanted[0]} came back as ${got.join(", ") || "nothing"}`,
      );
    }
    const middle = from + Math.floor((to - from) / 2);
    const [head, tail] = await Promise.all([ask(from, middle), ask(middle, to)]);
    return [...head, ...tail];
  };

  const chunks = chunkLines(lines);
  const answers: PathResponse[][] = [];
  let index = 0;
  const asks = chunks.map((chunk) => {
    const from = index;
    index += chunk.length;
    return ask(from, index);
  });
  answers.push(...(await Promise.all(asks)));

  let flipped: Selection | null = null;
  for (const response of answers.flat()) {
    flipped = flipped ? appendPath(flipped, response) : fromResponse(response);
  }
  return { selection: flipped!, requests };
}
