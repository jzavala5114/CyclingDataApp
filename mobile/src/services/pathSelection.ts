import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, LineString, Position } from "geojson";
import type { PathEnd, PathPiece, PathResponse, PathSpan, PathStop, SlopeBand } from "../types";

// A press-and-hold selection, held on the phone: the path GET /segments/path
// grew (backend/src/services/pathResponse.ts), every distance measured from the
// selection's own start. Joining answers on, cutting, the card's numbers and
// the map's features are all plain arithmetic here, so `tsx --test` covers
// them with no phone. The design is context/session.md, "Press and hold on a
// segment, designed 2026-10-17".

/** Why a selection ends: the path's own reason, or `cut` where the rider ended it short of that. */
export type SelectionEnd = PathEnd | "cut";

export interface Selection {
  pieces: PathPiece[];
  spans: PathSpan[];
  lengthM: number;
  stop: Omit<PathStop, "reason"> & { reason: SelectionEnd };
  bands: SlopeBand[];
}

export function fromResponse(response: PathResponse): Selection {
  return {
    pieces: response.pieces,
    spans: response.spans,
    lengthM: response.lengthM,
    stop: response.stop,
    bands: response.bands,
  };
}

/** The height at the end of a run of spans, in metres above its start. */
function endHeightM(spans: readonly PathSpan[]): number {
  const last = spans[spans.length - 1];
  return last ? last.heightM + last.riseM : 0;
}

// Re-measures `pieces` and `spans` from a point `offsetM` along, `offsetPiece`
// pieces in and `baseHeightM` up: what an answer needs to sit after something.
function shifted(response: Pick<Selection, "pieces" | "spans">, offsetM: number, offsetPiece: number, baseHeightM: number) {
  return {
    pieces: response.pieces.map((p) => ({ ...p, atM: p.atM + offsetM })),
    spans: response.spans.map((s) => ({
      ...s,
      atM: s.atM + offsetM,
      piece: s.piece + offsetPiece,
      heightM: s.heightM + baseHeightM,
    })),
  };
}

// An answer that carries the selection on from its end. The server measures
// each answer from its own start, heights included, so it is shifted to start
// where the selection ends and as high as the selection ends: the profile then
// runs on without a step.
export function appendPath(selection: Selection, response: PathResponse): Selection {
  const after = shifted(response, selection.lengthM, selection.pieces.length, endHeightM(selection.spans));
  return {
    pieces: [...selection.pieces, ...after.pieces],
    spans: [...selection.spans, ...after.spans],
    lengthM: selection.lengthM + response.lengthM,
    stop: { ...response.stop, atM: response.stop.atM + selection.lengthM },
    bands: response.bands,
  };
}

// An answer that leads into the selection's start: the selection moves along
// by the answer's length, and up by the height the answer ends at, so heights
// still count from the new start.
export function prependPath(selection: Selection, response: PathResponse): Selection {
  const after = shifted(selection, response.lengthM, response.pieces.length, endHeightM(response.spans));
  return {
    pieces: [...response.pieces, ...after.pieces],
    spans: [...response.spans, ...after.spans],
    lengthM: response.lengthM + selection.lengthM,
    stop: { ...selection.stop, atM: selection.stop.atM + response.lengthM },
    bands: selection.bands,
  };
}

// The stretch of a line between two fractions of its length. The server cuts
// pieces in travel metres along the segment, and offsetting a curve changes
// its length a little, so a piece is cut by fraction rather than by metres.
export function sliceLine(line: LineString, fromFraction: number, toFraction: number): LineString {
  const lengthM = turf.length(turf.lineString(line.coordinates), { units: "meters" });
  if (lengthM === 0) return line;
  const from = Math.max(0, Math.min(1, fromFraction)) * lengthM;
  const to = Math.max(0, Math.min(1, toFraction)) * lengthM;
  return turf.lineSliceAlong(turf.lineString(line.coordinates), from, to, { units: "meters" }).geometry;
}

/** The point `fraction` of the way along a line. */
function pointAlong(line: LineString, fraction: number): Position {
  const lengthM = turf.length(turf.lineString(line.coordinates), { units: "meters" });
  if (lengthM === 0 || line.coordinates.length < 2) return line.coordinates[0]!;
  return turf.along(turf.lineString(line.coordinates), Math.max(0, Math.min(1, fraction)) * lengthM, { units: "meters" })
    .geometry.coordinates;
}

// Everything up to `m` metres along. A piece or span the cut falls inside is
// shortened; a span's rise shrinks with it, its slope being constant across
// it. Cutting short of the path's end changes why it ends, so the stop then
// reads `cut`, with no branches.
export function cutAt(selection: Selection, m: number): Selection {
  const cutM = Math.max(0, Math.min(selection.lengthM, m));
  if (cutM >= selection.lengthM) return selection;
  const pieces: PathPiece[] = [];
  for (const piece of selection.pieces) {
    if (piece.atM >= cutM) break;
    const keepM = cutM - piece.atM;
    if (keepM >= piece.lengthM) {
      pieces.push(piece);
      continue;
    }
    pieces.push({
      ...piece,
      toM: piece.fromM + keepM,
      lengthM: keepM,
      geometry: sliceLine(piece.geometry, 0, keepM / piece.lengthM),
    });
    break;
  }
  const spans: PathSpan[] = [];
  for (const span of selection.spans) {
    if (span.atM >= cutM) break;
    const keepM = cutM - span.atM;
    if (keepM >= span.lengthM) {
      spans.push(span);
      continue;
    }
    spans.push({ ...span, lengthM: keepM, riseM: span.riseM * (keepM / span.lengthM) });
    break;
  }
  return { ...selection, pieces, spans, lengthM: cutM, stop: { reason: "cut", atM: cutM, aheadM: 0, branches: [] } };
}

/** The piece `m` metres along lies on: the earlier one where two meet, so an end lies on the piece it ends. */
export function pieceAt(selection: Selection, m: number): number {
  const { pieces } = selection;
  for (let i = 0; i < pieces.length; i++) {
    if (m <= pieces[i]!.atM + pieces[i]!.lengthM) return i;
  }
  return pieces.length - 1;
}

/** Where on the network a point `m` metres along the selection lies: its line, its travel metres, and its coordinate. */
export function pointOnPath(selection: Selection, m: number) {
  const index = pieceAt(selection, m);
  const piece = selection.pieces[index];
  if (!piece) return null;
  const intoM = Math.max(0, Math.min(piece.lengthM, m - piece.atM));
  const [lon, lat] = pointAlong(piece.geometry, piece.lengthM > 0 ? intoM / piece.lengthM : 0);
  return { segmentId: piece.segmentId, direction: piece.direction, atM: piece.fromM + intoM, lon: lon!, lat: lat! };
}

/** The segments a selection runs over, in order, each once. */
export function selectionSegmentIds(selection: Selection): number[] {
  return [...new Set(selection.pieces.map((p) => p.segmentId))];
}

// ---- The card's numbers ----

/** How far a window the "steepest" figure is taken over: 100m, 330ft. */
export const STEEPEST_WINDOW_M = 100;
// A window more than a quarter estimated is not trusted for "steepest": a
// stretch with no data gets one slope read off the heights at its two ends,
// and rides sit at different levels, so a long one can carry a slope nobody
// rode. The short unmeasured joins at junctions stay in.
const STEEPEST_MAX_ESTIMATED = 0.25;

export interface BandShare {
  color: string;
  /** The band's lower edge, null for the open-ended bottom band. */
  minSlopePct: number | null;
  maxSlopePct: number | null;
  lengthM: number;
  share: number;
}

export interface SelectionStats {
  distanceM: number;
  climbM: number;
  descentM: number;
  /** Net change in height over the selection, negative downhill. */
  netM: number;
  /** Net change over distance, as a percentage; null for an empty selection. */
  averageGradePct: number | null;
  /** The steepest 100m, uphill or down, whichever is steeper; null under 100m. */
  steepest: { gradePct: number; atM: number } | null;
  /** Each band's share of the distance, measured ground only, in the bands' order. */
  bands: BandShare[];
  /** Distance with no data, its slope estimated; it counts in the distance and the climb. */
  noDataM: number;
  /** The fewest and most rides behind any measured piece; null with no measured ground. */
  rides: { min: number; max: number } | null;
  lastRiddenAt: string | null;
  streetNames: string[];
}

/** Which band a span's colour belongs to: by its colour, which the server picked from the same table, else by its slope. */
export function bandIndex(bands: readonly SlopeBand[], color: string, slopePct: number): number {
  const byColor = bands.findIndex((b) => b.color === color);
  if (byColor >= 0) return byColor;
  const bySlope = bands.findIndex((b) => b.maxSlopePct === null || slopePct <= b.maxSlopePct);
  return bySlope >= 0 ? bySlope : bands.length - 1;
}

// The height `x` metres along, above the start: each span's height at its start
// plus its rise in proportion. Between span starts the height is a straight
// line, so the profile is exact, not sampled.
/** The span `x` metres along falls in, and the height there from the start: what the profile draws at `x`. */
export function profileAt(spans: readonly PathSpan[], x: number): { span: PathSpan; heightM: number } | null {
  let lo = 0;
  let hi = spans.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid]!.atM <= x) lo = mid;
    else hi = mid - 1;
  }
  const span = spans[lo]!;
  const intoM = Math.max(0, Math.min(span.lengthM, x - span.atM));
  return { span, heightM: span.heightM + (span.lengthM > 0 ? span.riseM * (intoM / span.lengthM) : 0) };
}

function heightAt(spans: readonly PathSpan[], x: number): number {
  return profileAt(spans, x)?.heightM ?? 0;
}

// The steepest window of `windowM`, by its net grade, uphill or down, among
// windows at most STEEPEST_MAX_ESTIMATED estimated.
//
// Exact, not sampled. Where a window starts, x, its net change and its
// estimated metres are both straight lines in x between consecutive
// breakpoints: the span boundaries, and those boundaries less `windowM`, where
// the window's far edge crosses one. A straight line peaks at an end of its
// stretch, and the estimated limit cuts a stretch at most once, so the
// steepest allowed window starts at a breakpoint or at the point where the
// estimated share crosses the limit.
function steepestWindow(spans: readonly PathSpan[], lengthM: number, windowM: number) {
  if (lengthM < windowM || spans.length === 0) return null;
  const lastX = lengthM - windowM;
  const edges = spans.flatMap((s) => [s.atM, s.atM + s.lengthM]);
  const xs = [...new Set([0, lastX, ...edges, ...edges.map((e) => e - windowM)])]
    .filter((x) => x >= 0 && x <= lastX)
    .sort((a, b) => a - b);

  // Estimated metres up to `x`: a running sum over spans, read by binary search.
  const estimatedBefore: number[] = [0];
  for (const span of spans) estimatedBefore.push(estimatedBefore[estimatedBefore.length - 1]! + (span.source === "none" ? span.lengthM : 0));
  const estimatedTo = (x: number) => {
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid]!.atM + spans[mid]!.lengthM <= x) lo = mid + 1;
      else hi = mid;
    }
    const span = spans[lo];
    return estimatedBefore[lo]! + (span && span.source === "none" ? Math.max(0, x - span.atM) : 0);
  };
  const estimated = (x: number) => estimatedTo(x + windowM) - estimatedTo(x);
  const limitM = windowM * STEEPEST_MAX_ESTIMATED;

  const candidates: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const p = xs[i]!;
    const atP = estimated(p);
    if (atP <= limitM + 1e-9) candidates.push(p);
    const q = xs[i + 1];
    if (q === undefined) continue;
    const atQ = estimated(q);
    if ((atP - limitM) * (atQ - limitM) < 0) candidates.push(p + ((limitM - atP) / (atQ - atP)) * (q - p));
  }
  let best: { gradePct: number; atM: number } | null = null;
  for (const x of candidates) {
    const gradePct = ((heightAt(spans, x + windowM) - heightAt(spans, x)) / windowM) * 100;
    if (!best || Math.abs(gradePct) > Math.abs(best.gradePct) + 1e-12) best = { gradePct, atM: x };
  }
  return best;
}

// Everything the card says about the first `upToM` metres. The climb sums the
// rises of the slopes the map is coloured with, so card and map cannot
// disagree; the heights come from summing those slopes too, never from the
// means, whose levels differ ride to ride.
export function selectionStats(selection: Selection, upToM: number): SelectionStats {
  const cut = cutAt(selection, upToM);
  let climbM = 0;
  let descentM = 0;
  let noDataM = 0;
  const bandLengths = cut.bands.map(() => 0);
  for (const span of cut.spans) {
    if (span.riseM > 0) climbM += span.riseM;
    else descentM -= span.riseM;
    if (span.source === "none") noDataM += span.lengthM;
    else bandLengths[bandIndex(cut.bands, span.color, span.slopePct)]! += span.lengthM;
  }
  const netM = endHeightM(cut.spans);
  const distanceM = cut.lengthM;

  let rides: { min: number; max: number } | null = null;
  let lastRiddenAt: string | null = null;
  for (const piece of cut.pieces) {
    if (piece.source !== "none") {
      rides = rides
        ? { min: Math.min(rides.min, piece.rides), max: Math.max(rides.max, piece.rides) }
        : { min: piece.rides, max: piece.rides };
    }
    if (piece.lastRiddenAt && (!lastRiddenAt || piece.lastRiddenAt > lastRiddenAt)) lastRiddenAt = piece.lastRiddenAt;
  }

  return {
    distanceM,
    climbM,
    descentM,
    netM,
    averageGradePct: distanceM > 0 ? (netM / distanceM) * 100 : null,
    steepest: steepestWindow(cut.spans, distanceM, STEEPEST_WINDOW_M),
    bands: cut.bands.map((band, i) => ({
      color: band.color,
      minSlopePct: i === 0 ? null : cut.bands[i - 1]!.maxSlopePct,
      maxSlopePct: band.maxSlopePct,
      lengthM: bandLengths[i]!,
      share: distanceM > 0 ? bandLengths[i]! / distanceM : 0,
    })),
    noDataM,
    rides,
    lastRiddenAt,
    streetNames: streetNamesOf(cut.pieces),
  };
}

// A street the selection only touches, under this much of it, is a junction
// it passes through, not a street it runs along: the 9m link where a ramp
// meets a road would otherwise head the card.
export const NAMED_MIN_M = 20;

// The streets in the order ridden, each run of one name once, leaving out
// names the selection runs along for under NAMED_MIN_M in all, unless that
// leaves nothing.
function streetNamesOf(pieces: readonly PathPiece[]): string[] {
  const lengths = new Map<string, number>();
  for (const piece of pieces) {
    if (piece.streetName) lengths.set(piece.streetName, (lengths.get(piece.streetName) ?? 0) + piece.lengthM);
  }
  const long = new Set([...lengths].filter(([, m]) => m >= NAMED_MIN_M).map(([name]) => name));
  const keep = long.size > 0 ? long : new Set(lengths.keys());
  const names: string[] = [];
  for (const piece of pieces) {
    const name = piece.streetName;
    if (name && keep.has(name) && names[names.length - 1] !== name) names.push(name);
  }
  return names;
}

/** One column of the height profile. */
export interface ProfileColumn {
  heightM: number;
  color: string;
  noData: boolean;
}

// The profile as `count` columns of equal width, each the height and colour
// at its middle: one bar per 15m bucket would be thinner than a pixel on a
// long selection.
export function profileColumns(selection: Selection, upToM: number, count: number): ProfileColumn[] {
  const cut = cutAt(selection, upToM);
  if (cut.lengthM <= 0 || cut.spans.length === 0 || count <= 0) return [];
  const columns: ProfileColumn[] = [];
  let s = 0;
  for (let i = 0; i < count; i++) {
    const x = ((i + 0.5) / count) * cut.lengthM;
    while (s < cut.spans.length - 1 && cut.spans[s]!.atM + cut.spans[s]!.lengthM < x) s++;
    const span = cut.spans[s]!;
    columns.push({ heightM: heightAt(cut.spans, x), color: span.color, noData: span.source === "none" });
  }
  return columns;
}

// ---- The map's features ----

export interface SelectionFeatureProps {
  kind: "selection";
  piece: number;
  startM: number;
  endM: number;
  color: string;
  noData: boolean;
}

export type SelectionFeature = Feature<LineString, SelectionFeatureProps>;

// The selection as map features: one per run of spans on a piece that share a
// colour and whether they were measured, each knowing where along the path it
// starts and ends. The map shows the grown part by filtering on `endM`, so the
// features are built once per answer, not once per frame.
export function selectionFeatures(selection: Selection): SelectionFeature[] {
  const features: SelectionFeature[] = [];
  const bySpan = new Map<number, PathSpan[]>();
  for (const span of selection.spans) {
    const list = bySpan.get(span.piece);
    if (list) list.push(span);
    else bySpan.set(span.piece, [span]);
  }
  selection.pieces.forEach((piece, index) => {
    if (piece.lengthM <= 0) return;
    const spans = bySpan.get(index) ?? [];
    const runs: Array<{ startM: number; endM: number; color: string; noData: boolean }> = [];
    for (const span of spans) {
      const noData = span.source === "none";
      const last = runs[runs.length - 1];
      if (last && last.color === span.color && last.noData === noData && Math.abs(last.endM - span.atM) < 0.01) {
        last.endM = span.atM + span.lengthM;
      } else {
        runs.push({ startM: span.atM, endM: span.atM + span.lengthM, color: span.color, noData });
      }
    }
    // A piece the spans do not cover is drawn as unmeasured, so nothing the
    // rider selected is left off the map.
    if (runs.length === 0) runs.push({ startM: piece.atM, endM: piece.atM + piece.lengthM, color: NO_DATA_COLOR, noData: true });
    for (const run of runs) {
      const geometry = sliceLine(piece.geometry, (run.startM - piece.atM) / piece.lengthM, (run.endM - piece.atM) / piece.lengthM);
      features.push({
        type: "Feature",
        geometry,
        properties: { kind: "selection", piece: index, startM: run.startM, endM: run.endM, color: run.color, noData: run.noData },
      });
    }
  });
  return features;
}

// The one feature still growing: the run `grownM` falls inside, cut there.
// Drawn from its own small source, so a frame of growth sends one short line
// to the map rather than the whole selection again.
export function growingFeature(features: readonly SelectionFeature[], grownM: number): SelectionFeature | null {
  const run = features.find((f) => f.properties.startM < grownM && grownM < f.properties.endM);
  if (!run) return null;
  const { startM, endM } = run.properties;
  return { ...run, geometry: sliceLine(run.geometry, 0, (grownM - startM) / (endM - startM)) };
}

/** The bounds of the first `upToM` metres, west, south, east, north. */
export function selectionBounds(selection: Selection, upToM: number): [number, number, number, number] | null {
  const coordinates = cutAt(selection, upToM).pieces.flatMap((p) => p.geometry.coordinates);
  if (coordinates.length === 0) return null;
  const lons = coordinates.map((c) => c[0]!);
  const lats = coordinates.map((c) => c[1]!);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

export function featureCollection<T extends Feature>(features: T[]): FeatureCollection<T["geometry"], T["properties"]> {
  return { type: "FeatureCollection", features } as FeatureCollection<T["geometry"], T["properties"]>;
}

// ---- Words and units ----

/** Unmeasured ground: dashed, in the grey of the ride's live track. */
export const NO_DATA_COLOR = "#6b7280";

/** An international foot is exactly 0.3048m. */
const FT_PER_M = 1 / 0.3048;
/** Half a mile: below it a distance reads in feet. */
const FEET_BELOW_FT = 2640;

/** Thousands separated by commas, without leaning on Intl. */
function grouped(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Distance: feet to the nearest 10 below half a mile (a phone's position is
// good to a few metres, so single feet would be noise), miles to two decimals
// from there.
export function formatDistance(m: number): string {
  const ft = m * FT_PER_M;
  if (ft < FEET_BELOW_FT) return `${grouped(Math.round(ft / 10) * 10)} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

/** A height in feet. */
export function formatFeet(m: number): string {
  return `${grouped(Math.abs(m) * FT_PER_M)} ft`;
}

const MINUS = "−";

/** A height from the start, with its sign: "+120 ft", "−40 ft", "0 ft". */
export function formatRise(m: number): string {
  const text = formatFeet(m);
  if (text === "0 ft") return text;
  return `${m > 0 ? "+" : MINUS}${text}`;
}

/** A grade with its sign: "+3.1%", "−2.0%". */
export function formatGrade(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  if (rounded === 0) return "0.0%";
  return `${rounded > 0 ? "+" : MINUS}${Math.abs(rounded).toFixed(1)}%`;
}

/** A band's range, "0 to 3%", "below −8%", "over 12%". */
export function formatBand(band: Pick<BandShare, "minSlopePct" | "maxSlopePct">): string {
  const n = (v: number) => (v < 0 ? `${MINUS}${Math.abs(v)}` : String(v));
  if (band.minSlopePct === null && band.maxSlopePct !== null) return `below ${n(band.maxSlopePct)}%`;
  if (band.maxSlopePct === null && band.minSlopePct !== null) return `over ${n(band.minSlopePct)}%`;
  return `${n(band.minSlopePct ?? 0)} to ${n(band.maxSlopePct ?? 0)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 8", or "Oct 8, 2025" outside the current year. Local time, as the rider lived it. */
export function formatRideDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

/** "built from 4 rides", "built from 2 to 9 rides". */
export function formatRides(rides: { min: number; max: number }): string {
  const count = rides.min === rides.max ? `${rides.min}` : `${rides.min} to ${rides.max}`;
  return `built from ${count} ride${rides.max === 1 ? "" : "s"}`;
}
