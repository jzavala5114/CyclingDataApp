import * as turf from "@turf/turf";
import type { LineString, Position } from "geojson";
import type { Direction, DirectionalGradientLine, PathBranch, PathPiece, PathSpan, SegmentWithGradients } from "../types";
import { NO_DATA_COLOR, type Selection } from "./pathSelection";

// The phone's half of a press: which line the finger is on, where along it,
// and what to draw while the server's answer is on its way.

// ---- Which line ----

/** A drawn line the finger may mean, as the map renders it. */
export interface LineUnderFinger {
  segmentId: number;
  direction: Direction;
  geometry: LineString;
}

// The line nearest the finger, by ground distance to what the map draws. The
// two lines of a street sit 8m apart, 17 points at zoom 17 and 4 at zoom 15,
// so the box around the finger usually holds both, and the nearer one is the
// side of the street the finger is on.
export function nearestLine<T extends LineUnderFinger>(lines: readonly T[], lonLat: Position): (T & { distanceM: number }) | null {
  let best: (T & { distanceM: number }) | null = null;
  for (const line of lines) {
    if (line.geometry.coordinates.length < 2) continue;
    const distanceM = turf.pointToLineDistance(turf.point(lonLat), turf.lineString(line.geometry.coordinates), {
      units: "meters",
    });
    if (!best || distanceM < best.distanceM) best = { ...line, distanceM };
  }
  return best;
}

// ---- Where along it ----

// Metres along `direction` to the point of the segment's centreline nearest
// `lonLat`, as GET /segments/path measures a press (travelMAt in
// backend/src/routes/segments.ts): turf measures along the geometry, which can
// differ a little from the stored length every other distance uses, so it is
// rescaled onto that.
export function travelMAt(segment: Pick<SegmentWithGradients, "geom" | "lengthM">, direction: Direction, lonLat: Position): number {
  const line = turf.lineString(segment.geom.coordinates);
  const geometryM = turf.length(line, { units: "meters" });
  const nearest = turf.nearestPointOnLine(line, lonLat, { units: "meters" });
  const forwardM = nearest.properties.totalDistance * (geometryM > 0 ? segment.lengthM / geometryM : 1);
  const travelM = direction === "forward" ? forwardM : segment.lengthM - forwardM;
  return Math.max(0, Math.min(segment.lengthM, travelM));
}

// The stretch of a segment a drawn line covers, in travel metres: the line's
// two ends measured onto the centreline. The server moves a pressed point onto
// this stretch (locate in backend/src/routes/segments.ts), and a hold that
// names its own point must do the same, or the selection would join onto
// ground the map shows nothing for.
export function drawnTravelRange(
  segment: Pick<SegmentWithGradients, "geom" | "lengthM">,
  line: Pick<DirectionalGradientLine, "direction" | "geometry">,
): { fromM: number; toM: number } {
  const coordinates = line.geometry.coordinates;
  const a = travelMAt(segment, line.direction, coordinates[0]!);
  const b = travelMAt(segment, line.direction, coordinates[coordinates.length - 1]!);
  return { fromM: Math.min(a, b), toM: Math.max(a, b) };
}

/** Where a finger at `lonLat` holds a drawn line, in travel metres, moved onto the stretch it draws. */
export function heldTravelM(
  segment: Pick<SegmentWithGradients, "geom" | "lengthM">,
  line: Pick<DirectionalGradientLine, "direction" | "geometry">,
  lonLat: Position,
): number {
  const { fromM, toM } = drawnTravelRange(segment, line);
  return Math.max(fromM, Math.min(toM, travelMAt(segment, line.direction, lonLat)));
}

// ---- What to draw while waiting ----

// A stand-in selection along the pressed line, from the finger ahead to the
// end of its drawn stretch, coloured as the map colours it: the server's
// answer takes 1.5 to 5.6s live, and the phone already holds this much. It has
// no heights, so the card waits for the answer; growth runs along it from the
// moment the hold registers, and carries on along the answer, which starts at
// the same point.
export function previewSelection(
  segment: Pick<SegmentWithGradients, "id" | "streetName">,
  line: DirectionalGradientLine,
  lonLat: Position,
): Selection | null {
  const coordinates = line.geometry.coordinates;
  if (coordinates.length < 2 || line.colorStops.length === 0) return null;
  const forwardLine = turf.lineString(coordinates);
  const geometryM = turf.length(forwardLine, { units: "meters" });
  if (geometryM === 0) return null;
  const pressedM = turf.nearestPointOnLine(forwardLine, lonLat, { units: "meters" }).properties.totalDistance;

  // The colour stops count along the geometry, which runs forward whichever
  // way the line is travelled (offsetTravelSlice in the server's
  // gradientBuilder.ts), as runs of [from, to) fractions.
  const stops = [...line.colorStops, { distanceFraction: 1, color: line.colorStops[line.colorStops.length - 1]!.color }];
  const forwardRuns: Array<{ from: number; to: number; color: string }> = [];
  for (let i = 0; i < stops.length - 1; i++) {
    if (stops[i + 1]!.distanceFraction > stops[i]!.distanceFraction) {
      forwardRuns.push({ from: stops[i]!.distanceFraction, to: stops[i + 1]!.distanceFraction, color: stops[i]!.color });
    }
  }
  const forward = line.direction === "forward";
  const travelRuns = forward
    ? forwardRuns
    : forwardRuns.map((r) => ({ from: 1 - r.to, to: 1 - r.from, color: r.color })).reverse();
  const travelCoordinates = forward ? coordinates : [...coordinates].reverse();
  const startFraction = forward ? pressedM / geometryM : 1 - pressedM / geometryM;

  const lengthM = (1 - startFraction) * geometryM;
  if (lengthM < 1) return null;
  const travelLine = turf.lineString(travelCoordinates);
  const geometry = turf.lineSliceAlong(travelLine, startFraction * geometryM, geometryM, { units: "meters" }).geometry;
  const piece: PathPiece = {
    segmentId: segment.id,
    direction: line.direction,
    streetName: segment.streetName,
    fromM: 0,
    toM: lengthM,
    atM: 0,
    lengthM,
    source: "line",
    rule: "start",
    geometry,
    rides: 0,
    lastRiddenAt: null,
  };
  const spans: PathSpan[] = [];
  for (const run of travelRuns) {
    const from = Math.max(run.from, startFraction);
    if (run.to <= from) continue;
    spans.push({
      atM: (from - startFraction) * geometryM,
      lengthM: (run.to - from) * geometryM,
      slopePct: 0,
      color: run.color,
      source: "line",
      piece: 0,
      heightM: 0,
      riseM: 0,
      rides: 0,
    });
  }
  if (spans.length === 0) {
    spans.push({ atM: 0, lengthM, slopePct: 0, color: NO_DATA_COLOR, source: "none", piece: 0, heightM: 0, riseM: 0, rides: 0 });
  }
  return { pieces: [piece], spans, lengthM, stop: { reason: "cut", atM: lengthM, aheadM: 0, branches: [] }, bands: [] };
}

// ---- How fast it grows ----

// Growth is paced on screen, not on the ground: the same hold looks the same
// at every zoom. It starts slow enough to stop on a chosen junction and speeds
// up for a long climb.
export const START_SPEED_PT_PER_S = 120;
export const TOP_SPEED_PT_PER_S = 400;
export const RAMP_S = 2;
/** At each junction the fork rule decided, growth pauses this long, so a turn reads as a choice. */
export const FORK_PAUSE_MS = 150;

export function growthSpeedPtPerS(heldS: number): number {
  return START_SPEED_PT_PER_S + (TOP_SPEED_PT_PER_S - START_SPEED_PT_PER_S) * Math.max(0, Math.min(1, heldS / RAMP_S));
}

const EARTH_CIRCUMFERENCE_M = 40075016.686;

// Ground metres per screen point. MapLibre's zoom counts 512-point tiles, and
// the ground a tile spans shrinks with the cosine of the latitude.
export function metresPerPoint(zoom: number, latDeg: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180)) / (512 * 2 ** zoom);
}

// ---- What a touch found ----

/** A feature as queryRenderedFeatures returns it. */
export interface RenderedFeature {
  geometry: { type: string; coordinates?: unknown };
  properties?: Record<string, unknown> | null;
}

/** The selection's lines win a tie this close: the base line under them is the same line. */
const PREFER_WITHIN_M = 1;

// The layers a touch is tested against besides the base lines: everything
// that draws the selection's own line, the runs fully grown and the one still
// growing (let go mid-run, the tip the rider aims at is drawn by that one
// alone), and a fork's branches. SelectionLayers.tsx names its layers from
// these, so the two cannot drift apart.
export const SELECTION_LAYER = {
  line: "selection-line",
  gap: "selection-gap",
  growingLine: "selection-growing-line",
  growingGap: "selection-growing-gap",
  branchLine: "selection-branch-line",
} as const;
export const SELECTION_HIT_LAYERS: string[] = Object.values(SELECTION_LAYER);

// What the finger is on, from the features rendered around it: the
// selection, a fork's branch, or a drawn line, whichever is nearest, the
// selection first and a branch second where they are as near as a line. The
// base line under the selection is the selection's own line, so on a tie the
// selection is what the finger meant.
export function hitFromFeatures(
  features: readonly RenderedFeature[],
  lonLat: Position,
  zoom: number,
  segments: ReadonlyMap<number, SegmentWithGradients>,
  branchAt: (index: number) => PathBranch | undefined,
) {
  const lineOf = (f: RenderedFeature): LineString | null =>
    f.geometry.type === "LineString" && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length >= 2
      ? (f.geometry as LineString)
      : null;
  const nearestOf = (kind: string | undefined) => {
    let best: { feature: RenderedFeature; distanceM: number } | null = null;
    for (const feature of features) {
      if ((feature.properties?.kind as string | undefined) !== kind) continue;
      const geometry = lineOf(feature);
      if (!geometry) continue;
      const distanceM = turf.pointToLineDistance(turf.point(lonLat), turf.lineString(geometry.coordinates), { units: "meters" });
      if (!best || distanceM < best.distanceM) best = { feature, distanceM };
    }
    return best;
  };
  const selected = nearestOf("selection");
  const branch = nearestOf("branch");
  const base = nearestOf(undefined);
  const baseM = base?.distanceM ?? Infinity;
  const empty = { lonLat, zoom, line: null, piece: null, branch: null };

  if (selected && selected.distanceM <= Math.min(baseM, branch?.distanceM ?? Infinity) + PREFER_WITHIN_M) {
    return { ...empty, piece: Number(selected.feature.properties!.piece) };
  }
  if (branch && branch.distanceM <= baseM + PREFER_WITHIN_M) {
    const found = branchAt(Number(branch.feature.properties!.index));
    if (found) return { ...empty, branch: found };
  }
  if (!base) return empty;
  const segment = segments.get(Number(base.feature.properties?.segmentId));
  const drawing = segment?.directionalLines.find((l) => l.direction === base.feature.properties?.direction);
  return segment && drawing ? { ...empty, line: { segment, drawing } } : empty;
}
