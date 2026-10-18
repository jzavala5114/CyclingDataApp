import * as turf from "@turf/turf";
import { clampSlope, colorForSlope, type LineDrawing } from "./gradientBuilder.js";
import { buildEndAdjacency, type EndNeighbours } from "./segmentMatcher.js";
import type { Direction, ElevationBucket, Segment } from "../types/index.js";

// The path a press-and-hold selection grows along: from the pressed line,
// ahead in its direction of travel, choosing a branch at each fork, until it
// runs out of road, hits a fork it cannot call, or reaches ground nobody has
// measured for too long. The design and Julian's four decisions behind it are
// in context/session.md, "Designed 2026-10-17, not built: press and hold on a
// segment".
//
// Everything here is pure: the route and `npm run eval:path` load the graph
// (pathData.ts) and hand it in, so the eval measures exactly the code the
// route runs.
//
// A line is one direction of one segment. A segment's two lines are drawn on
// the right-hand side of their own direction of travel (gradientBuilder.ts),
// so the line a rider presses already says which way they mean to go, and
// growth never turns around onto the other side of the same street.

// Ends that meet on the ground within this distance are joined even when they
// share no OSM node. The node graph has no edge at 1,987 canonical pairs whose
// real ends lie within 5m of each other (ENDPOINT_SNAP_M's comment in
// segmentMatcher.ts), Palmer Point Trail's two halves among them, and growth
// would stop dead at every one. The matcher keeps 0, because for it an
// invented edge draws paint; for a selection a false edge costs one wrong hop
// the rider can trim, and a missing one ends the selection where they rode on.
export const PATH_SNAP_M = 5;

// The least-turn rule takes a branch only if it bends this much or less. Past
// it the branch is a turn, not the road carrying on, and growth would rather
// stop and let the rider pick.
export const MAX_TURN_DEG = 60;

// How far a selection may run on ground with no data in either direction, in
// one stretch, before growth stops there. Long enough to cross the short holes
// the matcher leaves between lines; short enough that the card's numbers are
// still mostly measured.
export const MAX_NO_DATA_M = 150;

// How far one request grows, and how long a connection between two points of
// a selection may be. The phone asks again from the tip to go further.
export const MAX_PATH_M = 5000;
export const MAX_CONNECT_M = 2000;

// A connection prefers measured ground: a metre with no data counts as this
// many metres when the cheapest way between two points is chosen.
const NO_DATA_COST = 2;

// How much of a line's end its heading is measured over: one bucket.
const HEADING_SPAN_M = 15;

/** Where a piece's numbers come from: its own line, the other direction's line read backwards, or nowhere. */
export type Source = "line" | "twin" | "none";

/** The rules growth picks a branch by, in the order it tries them. "least" is the eval's baseline only. */
export type RuleName = "history" | "name" | "turn" | "only" | "least";
export const DEFAULT_RULES: readonly RuleName[] = ["history", "name", "turn", "only"];

/** How a piece's segment joined the path. */
export type PieceRule = "start" | "connect" | RuleName;

export type StopReason = "end" | "fork" | "gap" | "loop" | "limit";

export interface LineRef {
  segmentId: number;
  direction: Direction;
}

/** A point on a line: `atM` is metres along the segment in the line's direction of travel. */
export interface PathPoint extends LineRef {
  atM: number;
}

/** The drawn stretch of a line, in metres along its direction of travel (drawnExtent). */
export interface Extent {
  fromM: number;
  toM: number;
}

/** One ride going from one stored line straight on to the next. */
export interface Transition {
  sessionId: number;
  from: LineRef;
  to: LineRef;
}

export interface PathGraph {
  segments: ReadonlyMap<number, Segment>;
  ends: ReadonlyMap<number, EndNeighbours>;
  /** Every line with data, by lineKey. */
  extents: ReadonlyMap<string, Extent>;
  /** lineKey -> next lineKey -> the sessions that rode that way. */
  transitions: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  /**
   * Whether a junction at this point can be decided: the graph holds every
   * segment around it. The route loads a box, so near its edge a branch may be
   * missing and growth stops with `limit` instead of guessing without it.
   */
  decidable: (point: readonly number[]) => boolean;
}

export const lineKey = ({ segmentId, direction }: LineRef) => `${segmentId}:${direction}`;
export const oppositeOf = (direction: Direction): Direction => (direction === "forward" ? "backward" : "forward");

export function buildPathGraph(input: {
  segments: readonly Segment[];
  extents: ReadonlyMap<string, Extent>;
  transitions: readonly Transition[];
  decidable?: (point: readonly number[]) => boolean;
  snapM?: number;
}): PathGraph {
  const transitions = new Map<string, Map<string, Set<number>>>();
  for (const { sessionId, from, to } of input.transitions) {
    const out = transitions.get(lineKey(from)) ?? new Map<string, Set<number>>();
    const sessions = out.get(lineKey(to)) ?? new Set<number>();
    sessions.add(sessionId);
    out.set(lineKey(to), sessions);
    transitions.set(lineKey(from), out);
  }
  return {
    segments: new Map(input.segments.map((segment) => [segment.id, segment])),
    ends: buildEndAdjacency([...input.segments], input.snapM ?? PATH_SNAP_M),
    extents: input.extents,
    transitions,
    decidable: input.decidable ?? (() => true),
  };
}

function travelCoords(segment: Segment, direction: Direction): number[][] {
  const coords = segment.geom.coordinates;
  return direction === "forward" ? coords : [...coords].reverse();
}

// The compass bearing of travel over the last HEADING_SPAN_M before a line's
// exit, and over the first after its entry.
function exitBearing(segment: Segment, direction: Direction): number {
  const line = turf.lineString(travelCoords(segment, direction));
  const lengthM = turf.length(line, { units: "meters" });
  const from = turf.along(line, Math.max(0, lengthM - HEADING_SPAN_M), { units: "meters" });
  return turf.bearing(from, turf.point(line.geometry.coordinates[line.geometry.coordinates.length - 1]!));
}

function entryBearing(segment: Segment, direction: Direction): number {
  const line = turf.lineString(travelCoords(segment, direction));
  const lengthM = turf.length(line, { units: "meters" });
  const to = turf.along(line, Math.min(lengthM, HEADING_SPAN_M), { units: "meters" });
  return turf.bearing(turf.point(line.geometry.coordinates[0]!), to);
}

/** How far a rider turns going from one bearing to another, 0 (straight on) to 180 (back). */
export function turnDeg(fromBearing: number, toBearing: number): number {
  return Math.abs(((((toBearing - fromBearing) % 360) + 540) % 360) - 180);
}

function sourceOf(graph: PathGraph, line: LineRef): Source {
  if (graph.extents.has(lineKey(line))) return "line";
  if (graph.extents.has(lineKey({ segmentId: line.segmentId, direction: oppositeOf(line.direction) }))) return "twin";
  return "none";
}

/** A line growth could take next. `source` is what data it has anywhere along it. */
export interface Candidate extends LineRef {
  key: string;
  source: Source;
  turnDeg: number;
  streetName: string | null;
}

// The lines entered at the far end of `line`. A neighbour is entered at
// whichever of its ends lies nearer the exit, which settles the direction it
// is travelled in: the adjacency says which of OUR ends a neighbour touches,
// not which of its own. The segment itself is never its own neighbour
// (buildEndAdjacency), so the other side of the same street is never offered:
// growth does not turn around.
function neighboursAt(graph: PathGraph, line: LineRef): Array<{ next: Segment; direction: Direction }> {
  const segment = graph.segments.get(line.segmentId);
  if (!segment) return [];
  const touching = graph.ends.get(segment.id)?.[line.direction === "forward" ? "end" : "start"];
  if (!touching || touching.size === 0) return [];
  const exit = travelCoords(segment, line.direction).at(-1)!;
  const neighbours: Array<{ next: Segment; direction: Direction }> = [];
  for (const id of touching) {
    const next = graph.segments.get(id);
    if (!next) continue;
    const coords = next.geom.coordinates;
    const direction: Direction =
      turf.distance(exit, coords[0]!) <= turf.distance(exit, coords[coords.length - 1]!) ? "forward" : "backward";
    neighbours.push({ next, direction });
  }
  return neighbours.sort((a, b) => a.next.id - b.next.id || a.direction.localeCompare(b.direction));
}

export function candidatesAt(graph: PathGraph, line: LineRef): Candidate[] {
  const neighbours = neighboursAt(graph, line);
  if (neighbours.length === 0) return [];
  const bearingOut = exitBearing(graph.segments.get(line.segmentId)!, line.direction);
  return neighbours.map(({ next, direction }) => {
    const ref = { segmentId: next.id, direction };
    return {
      ...ref,
      key: lineKey(ref),
      source: sourceOf(graph, ref),
      turnDeg: turnDeg(bearingOut, entryBearing(next, direction)),
      streetName: next.streetName,
    };
  });
}

// Case and spacing do not make two streets different: a name compared raw
// split one street in two once already (siteKeyFor, 2026-09).
const nameKey = (name: string | null) => (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

const SOURCE_RANK: Record<Source, number> = { line: 0, twin: 1, none: 2 };
const byTurn = (a: Candidate, b: Candidate) =>
  a.turnDeg - b.turnDeg || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.segmentId - b.segmentId;
const byData = (a: Candidate, b: Candidate) =>
  SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.turnDeg - b.turnDeg || a.segmentId - b.segmentId;

function ridesBetween(graph: PathGraph, from: string, to: string, excludeSession?: number): number {
  const sessions = graph.transitions.get(from)?.get(to);
  if (!sessions) return 0;
  return sessions.size - (excludeSession !== undefined && sessions.has(excludeSession) ? 1 : 0);
}

export interface PickOptions {
  rules?: readonly RuleName[];
  /** Leave this ride's own transitions out of the history: the eval asks what growth would do on a new ride. */
  excludeSession?: number;
}

// The fork rule, Julian's decision of 2026-10-17. In order:
//   history: the line the most rides went on to from this one; a tie decides
//            nothing. Only lines drawn this way have rides.
//   name:    the line carrying on the same street name, the least turn first.
//   turn:    the line turning MAX_TURN_DEG or less, measured ground first,
//            then the least turn.
//   only:    a single way on is taken whatever it bends, switchbacks included.
// Null when no rule calls it: the caller stops at the fork.
export function pickNext(
  graph: PathGraph,
  current: LineRef,
  candidates: readonly Candidate[],
  { rules = DEFAULT_RULES, excludeSession }: PickOptions = {},
): { candidate: Candidate; rule: RuleName } | null {
  if (candidates.length === 0) return null;
  const from = lineKey(current);
  const currentName = nameKey(graph.segments.get(current.segmentId)?.streetName ?? null);
  for (const rule of rules) {
    switch (rule) {
      case "history": {
        const counted = candidates
          .filter((c) => c.source === "line")
          .map((c) => ({ c, rides: ridesBetween(graph, from, c.key, excludeSession) }))
          .filter(({ rides }) => rides > 0)
          .sort((a, b) => b.rides - a.rides);
        if (counted.length > 0 && (counted.length === 1 || counted[0]!.rides > counted[1]!.rides)) {
          return { candidate: counted[0]!.c, rule };
        }
        break;
      }
      case "name": {
        if (currentName === "") break;
        const named = candidates.filter((c) => nameKey(c.streetName) === currentName).sort(byTurn);
        if (named.length > 0) return { candidate: named[0]!, rule };
        break;
      }
      case "turn": {
        const gentle = candidates.filter((c) => c.turnDeg <= MAX_TURN_DEG).sort(byData);
        if (gentle.length > 0) return { candidate: gentle[0]!, rule };
        break;
      }
      case "only":
        if (candidates.length === 1) return { candidate: candidates[0]!, rule };
        break;
      case "least":
        return { candidate: [...candidates].sort(byTurn)[0]!, rule };
    }
  }
  return null;
}

/** A stretch of one line with one source of data. */
export interface SourcePart {
  fromM: number;
  toM: number;
  source: Source;
}

// Splits [fromM, toM] of a line (metres along `direction`) by where its
// numbers come from: its own drawn extent, else its twin's (the same ground
// ridden the other way, whose extent runs the other way along the segment),
// else none.
export function splitBySource(
  graph: PathGraph,
  segment: Segment,
  direction: Direction,
  fromM: number,
  toM: number,
): SourcePart[] {
  const own = graph.extents.get(lineKey({ segmentId: segment.id, direction }));
  const twinExtent = graph.extents.get(lineKey({ segmentId: segment.id, direction: oppositeOf(direction) }));
  const twin = twinExtent && { fromM: segment.lengthM - twinExtent.toM, toM: segment.lengthM - twinExtent.fromM };
  const cuts = [own?.fromM, own?.toM, twin?.fromM, twin?.toM].filter(
    (m): m is number => m !== undefined && m > fromM && m < toM,
  );
  const points = [fromM, ...[...new Set(cuts)].sort((a, b) => a - b), toM];

  const parts: SourcePart[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (!(b > a)) continue;
    const mid = (a + b) / 2;
    const source: Source =
      own && mid >= own.fromM && mid <= own.toM ? "line" : twin && mid >= twin.fromM && mid <= twin.toM ? "twin" : "none";
    const last = parts[parts.length - 1];
    if (last && last.source === source) last.toM = b;
    else parts.push({ fromM: a, toM: b, source });
  }
  return parts;
}

/** One stretch of the path: part of one line, with one source. `atM` is where it starts along the path. */
export interface PathPiece extends LineRef {
  fromM: number;
  toM: number;
  atM: number;
  source: Source;
  /** How this segment joined the path, on its first piece only. */
  rule: PieceRule | null;
}

export interface PathStop {
  reason: StopReason;
  /** At a fork: the lines the rider can hold to go on. */
  branches: Candidate[];
}

export interface GrownPath {
  pieces: PathPiece[];
  lengthM: number;
  stop: PathStop;
}

export interface GrowOptions extends PickOptions {
  maxM?: number;
  /** Segments already in the selection: reaching one again is a loop. */
  avoid?: Iterable<number>;
  /** The rule the first piece reports: "start" for a press. */
  startRule?: PieceRule;
}

const lengthOf = (pieces: readonly PathPiece[]) => {
  const last = pieces[pieces.length - 1];
  return last ? last.atM + (last.toM - last.fromM) : 0;
};

// Grows from `start` ahead along its line, then from junction to junction by
// the fork rule. Stops at the end of the network (`end`), at a fork no rule
// calls (`fork`, with its branches), past MAX_NO_DATA_M of ground with no data
// (`gap`), on reaching a segment already in the path in either direction
// (`loop`: a selection covering the same ground twice would count its climb
// twice), or at the length limit or the loaded area's edge (`limit`).
//
// A selection never ends on ground nobody measured: trailing no-data pieces
// are dropped, and the stop then reads `gap`, because that is what the rider
// sees past the end.
export function growPath(graph: PathGraph, start: PathPoint, options: GrowOptions = {}): GrownPath {
  const maxM = options.maxM ?? MAX_PATH_M;
  const pieces: PathPiece[] = [];
  const seen = new Set<number>(options.avoid);
  let lengthM = 0;
  let noDataM = 0;
  let line: LineRef = { segmentId: start.segmentId, direction: start.direction };
  let segment = graph.segments.get(line.segmentId);
  let enterM = segment ? Math.max(0, Math.min(segment.lengthM, start.atM)) : 0;
  let rule: PieceRule | null = options.startRule ?? "start";
  let stop: PathStop = { reason: "end", branches: [] };

  grow: while (segment) {
    seen.add(segment.id);
    for (const part of splitBySource(graph, segment, line.direction, enterM, segment.lengthM)) {
      const partM = part.toM - part.fromM;
      if (part.source === "none") {
        noDataM += partM;
        if (noDataM > MAX_NO_DATA_M) {
          stop = { reason: "gap", branches: [] };
          break grow;
        }
      } else {
        noDataM = 0;
      }
      const room = maxM - lengthM;
      if (room <= 0) {
        stop = { reason: "limit", branches: [] };
        break grow;
      }
      const toM = Math.min(part.toM, part.fromM + room);
      pieces.push({ ...line, fromM: part.fromM, toM, atM: lengthM, source: part.source, rule });
      rule = null;
      lengthM += toM - part.fromM;
      if (toM < part.toM) {
        stop = { reason: "limit", branches: [] };
        break grow;
      }
    }

    if (!graph.decidable(travelCoords(segment, line.direction).at(-1)!)) {
      stop = { reason: "limit", branches: [] };
      break;
    }
    const candidates = candidatesAt(graph, line);
    const picked = pickNext(graph, line, candidates, options);
    if (!picked) {
      stop = { reason: candidates.length > 0 ? "fork" : "end", branches: candidates };
      break;
    }
    if (seen.has(picked.candidate.segmentId)) {
      stop = { reason: "loop", branches: [] };
      break;
    }
    line = { segmentId: picked.candidate.segmentId, direction: picked.candidate.direction };
    segment = graph.segments.get(line.segmentId);
    enterM = 0;
    rule = picked.rule;
  }

  let trimmed = false;
  while (pieces.length > 0 && pieces[pieces.length - 1]!.source === "none") {
    pieces.pop();
    trimmed = true;
  }
  if (trimmed) stop = { reason: "gap", branches: [] };
  return { pieces, lengthM: lengthOf(pieces), stop };
}

// Pieces for a run of lines, each covering [fromM, toM] of its segment, split
// by source, with `rule` on each segment's first piece.
function piecesAlong(
  graph: PathGraph,
  legs: ReadonlyArray<LineRef & { fromM: number; toM: number }>,
  rule: PieceRule,
): PathPiece[] {
  const pieces: PathPiece[] = [];
  let atM = 0;
  for (const leg of legs) {
    const segment = graph.segments.get(leg.segmentId)!;
    let first = true;
    for (const part of splitBySource(graph, segment, leg.direction, leg.fromM, leg.toM)) {
      pieces.push({
        segmentId: leg.segmentId,
        direction: leg.direction,
        fromM: part.fromM,
        toM: part.toM,
        atM,
        source: part.source,
        rule: first ? rule : null,
      });
      first = false;
      atM += part.toM - part.fromM;
    }
  }
  return pieces;
}

// A binary heap of keys by cost, for the connection search.
class MinHeap {
  private items: Array<{ key: string; cost: number }> = [];
  get size() {
    return this.items.length;
  }
  push(key: string, cost: number) {
    const items = this.items;
    items.push({ key, cost });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]!.cost <= items[i]!.cost) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }
  pop(): { key: string; cost: number } {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left]!.cost < items[smallest]!.cost) smallest = left;
        if (right < items.length && items[right]!.cost < items[smallest]!.cost) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i]!, items[smallest]!];
        i = smallest;
      }
    }
    return top;
  }
}

// The cheapest way from one point of the network to another, travelling each
// line in its own direction, with no turning around: how a selection reaches a
// line the rider holds beyond its end, or how a hold behind its start reaches
// it. A metre with no data costs NO_DATA_COST. Null when there is no way within
// `maxM` metres of path.
export function connectPath(
  graph: PathGraph,
  from: PathPoint,
  to: PathPoint,
  maxM: number = MAX_CONNECT_M,
): PathPiece[] | null {
  const fromSegment = graph.segments.get(from.segmentId);
  const toSegment = graph.segments.get(to.segmentId);
  if (!fromSegment || !toSegment) return null;
  const fromAt = Math.max(0, Math.min(fromSegment.lengthM, from.atM));
  const toAt = Math.max(0, Math.min(toSegment.lengthM, to.atM));
  const fromKey = lineKey(from);
  const toKey = lineKey(to);
  const cost = (segment: Segment, direction: Direction, a: number, b: number) =>
    splitBySource(graph, segment, direction, a, b).reduce(
      (sum, part) => sum + (part.toM - part.fromM) * (part.source === "none" ? NO_DATA_COST : 1),
      0,
    );

  if (fromKey === toKey && toAt >= fromAt) {
    return toAt - fromAt <= maxM ? piecesAlong(graph, [{ ...from, fromM: fromAt, toM: toAt }], "connect") : null;
  }

  // Each label is the cost and length of reaching the far end of its line.
  const labels = new Map<string, { cost: number; lengthM: number; previous: string | null; line: LineRef }>();
  const startLabel = {
    cost: cost(fromSegment, from.direction, fromAt, fromSegment.lengthM),
    lengthM: fromSegment.lengthM - fromAt,
    previous: null,
    line: { segmentId: from.segmentId, direction: from.direction },
  };
  labels.set(fromKey, startLabel);
  const heap = new MinHeap();
  heap.push(fromKey, startLabel.cost);
  const settled = new Set<string>();
  let best: { cost: number; previous: string } | null = null;

  while (heap.size > 0) {
    const { key, cost: reached } = heap.pop();
    if (settled.has(key)) continue;
    settled.add(key);
    if (best && reached >= best.cost) break;
    const label = labels.get(key)!;
    if (label.lengthM > maxM) continue;
    for (const { next, direction } of neighboursAt(graph, label.line)) {
      const nextKey = lineKey({ segmentId: next.id, direction });
      if (nextKey === toKey) {
        const total = label.cost + cost(next, direction, 0, toAt);
        if (label.lengthM + toAt <= maxM && (!best || total < best.cost)) best = { cost: total, previous: key };
        // Passing through the target line reaches the target point first.
        continue;
      }
      // A line whose far end is already past the limit cannot lead anywhere
      // within it.
      const nextLengthM = label.lengthM + next.lengthM;
      if (nextLengthM > maxM) continue;
      const nextCost = label.cost + cost(next, direction, 0, next.lengthM);
      const known = labels.get(nextKey);
      if (settled.has(nextKey) || (known && known.cost <= nextCost)) continue;
      labels.set(nextKey, { cost: nextCost, lengthM: nextLengthM, previous: key, line: { segmentId: next.id, direction } });
      heap.push(nextKey, nextCost);
    }
  }
  if (!best) return null;

  const chain: LineRef[] = [];
  for (let key: string | null = best.previous; key !== null; key = labels.get(key)!.previous) {
    chain.unshift(labels.get(key)!.line);
  }
  const legs = chain.map((line, i) => {
    const segment = graph.segments.get(line.segmentId)!;
    return { ...line, fromM: i === 0 ? fromAt : 0, toM: segment.lengthM };
  });
  legs.push({ segmentId: to.segmentId, direction: to.direction, fromM: 0, toM: toAt });
  return piecesAlong(graph, legs, "connect");
}

/** One stretch of the path at one slope, as the map colours it. */
export interface PathSpan {
  atM: number;
  lengthM: number;
  slopePct: number;
  color: string;
  source: Source;
}

/** What the path needs of a line with data: how the map draws it, and its buckets sorted by distance. */
export interface LineData {
  drawing: LineDrawing;
  buckets: readonly ElevationBucket[];
}

// A drawing's colour stops as stretches of travel distance, each with its
// slope: the colour of a stop runs on to the next stop, the last to the end,
// and a stop that does not advance paints nothing. The same reading the phone
// gives `colorStops` (mobile/src/services/gradientRendering.ts).
export function drawnRanges(drawing: LineDrawing): Array<{ fromM: number; toM: number; slopePct: number; color: string }> {
  const { fromTravelM, toTravelM, stops } = drawing;
  const lengthM = toTravelM - fromTravelM;
  const ranges: Array<{ fromM: number; toM: number; slopePct: number; color: string }> = [];
  for (let k = 0; k < stops.length; k++) {
    const f0 = stops[k]!.distanceFraction;
    const f1 = k + 1 < stops.length ? stops[k + 1]!.distanceFraction : 1;
    if (!(f1 > f0)) continue;
    const [fromM, toM] =
      drawing.direction === "forward"
        ? [fromTravelM + f0 * lengthM, fromTravelM + f1 * lengthM]
        : [toTravelM - f1 * lengthM, toTravelM - f0 * lengthM];
    ranges.push({ fromM, toM, slopePct: stops[k]!.slopePct, color: stops[k]!.color });
  }
  return ranges.sort((a, b) => a.fromM - b.fromM);
}

// The height a line's buckets give at `travelM`, interpolated between the two
// either side; beyond the first or last, that bucket's.
function heightAt(buckets: readonly ElevationBucket[], travelM: number): number | null {
  if (buckets.length === 0) return null;
  if (travelM <= buckets[0]!.distanceM) return buckets[0]!.elevationM;
  for (let i = 1; i < buckets.length; i++) {
    const b = buckets[i]!;
    if (travelM <= b.distanceM) {
      const a = buckets[i - 1]!;
      const t = (travelM - a.distanceM) / (b.distanceM - a.distanceM);
      return a.elevationM + t * (b.elevationM - a.elevationM);
    }
  }
  return buckets[buckets.length - 1]!.elevationM;
}

// The slope of every stretch of the path, in order, tiling it exactly.
//
// A `line` piece takes the slopes the map draws on that line, so the card and
// the map cannot disagree. A `twin` piece takes the other direction's slopes,
// negated: the same ground, ridden the other way. A run of `none` pieces gets
// one estimated slope, from the heights the data gives at the two ends of the
// run, clamped like any slope. That estimate reads two levels, and rides sit
// at different levels (the mixing artefact), which is why it is marked: the
// card says how much of the path it covers. With no measured height on one
// side the run is drawn level.
//
// Heights are never plotted from the means: the profile is the running sum of
// these slopes, so a level step between two rides cannot draw a cliff.
export function pathSpans(
  graph: PathGraph,
  pieces: readonly PathPiece[],
  lines: ReadonlyMap<string, LineData>,
): PathSpan[] {
  const twinRef = (p: LineRef) => ({ segmentId: p.segmentId, direction: oppositeOf(p.direction) });
  const spansOf = (piece: PathPiece): PathSpan[] | null => {
    const segment = graph.segments.get(piece.segmentId)!;
    let ranges: Array<{ fromM: number; toM: number; slopePct: number }>;
    if (piece.source === "line") {
      const data = lines.get(lineKey(piece));
      if (!data) return null;
      ranges = drawnRanges(data.drawing);
    } else if (piece.source === "twin") {
      const data = lines.get(lineKey(twinRef(piece)));
      if (!data) return null;
      ranges = drawnRanges(data.drawing)
        .map((r) => ({ fromM: segment.lengthM - r.toM, toM: segment.lengthM - r.fromM, slopePct: -r.slopePct }))
        .sort((a, b) => a.fromM - b.fromM);
    } else {
      return null;
    }
    const spans: PathSpan[] = [];
    for (const r of ranges) {
      const fromM = Math.max(r.fromM, piece.fromM);
      const toM = Math.min(r.toM, piece.toM);
      if (!(toM > fromM)) continue;
      spans.push({
        atM: piece.atM + (fromM - piece.fromM),
        lengthM: toM - fromM,
        slopePct: r.slopePct,
        color: colorForSlope(r.slopePct),
        source: piece.source,
      });
    }
    return spans;
  };

  // Where the data puts a piece's two ends, for the estimates.
  const endHeight = (piece: PathPiece, end: "from" | "to"): number | null => {
    const segment = graph.segments.get(piece.segmentId)!;
    const travelM = end === "from" ? piece.fromM : piece.toM;
    if (piece.source === "line") return heightAt(lines.get(lineKey(piece))?.buckets ?? [], travelM);
    if (piece.source === "twin") {
      return heightAt(lines.get(lineKey(twinRef(piece)))?.buckets ?? [], segment.lengthM - travelM);
    }
    return null;
  };

  const measured = pieces.map(spansOf);
  const spans: PathSpan[] = [];
  for (let i = 0; i < pieces.length; ) {
    const own = measured[i];
    if (own !== null && own !== undefined) {
      spans.push(...own);
      i++;
      continue;
    }
    // A run of pieces with nothing to read: one estimate for all of it.
    let j = i;
    while (j < pieces.length && measured[j] === null) j++;
    const before = i > 0 ? endHeight(pieces[i - 1]!, "to") : null;
    const after = j < pieces.length ? endHeight(pieces[j]!, "from") : null;
    const runM = pieces.slice(i, j).reduce((sum, p) => sum + (p.toM - p.fromM), 0);
    const slopePct = before !== null && after !== null && runM > 0 ? clampSlope(((after - before) / runM) * 100) : 0;
    for (const piece of pieces.slice(i, j)) {
      spans.push({
        atM: piece.atM,
        lengthM: piece.toM - piece.fromM,
        slopePct,
        color: colorForSlope(slopePct),
        source: "none",
      });
    }
    i = j;
  }
  return spans;
}
