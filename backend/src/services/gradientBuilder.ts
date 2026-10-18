import * as turf from "@turf/turf";
import { BUCKET_SIZE_M } from "./elevationAggregator.js";
import type { Direction, ElevationBucket, PassBucket, Segment, SegmentCoverage } from "../types/index.js";

const OFFSET_M = 4;

// A bucket is the average of samples within half a bucket either side of its
// centre, so the ground a set of buckets actually covers runs from half a
// bucket before the first to half a bucket after the last.
const HALF_BUCKET_M = BUCKET_SIZE_M / 2;

// Slope (%) -> color stops. Descending goes purple (steepest) -> blue ->
// green, climbing goes green -> yellow -> orange -> red, matching the
// reference photo. Each band includes its upper edge.
//
// Climbs get darker reds past 9% and 12% (2026-10-14), so a 7% street and a
// 15% trail pitch no longer draw alike. The climb edges, 0/3/6/9/12, are Garmin
// ClimbPro's; the scale stops at 12% because above 15% was 220m on 7 trail
// lines through ride 89, where readings are noisiest. Bands stay separate
// rather than blended: slope carries about 0.8 points of error, so a blend
// would show it as shade flicker on every piece, the speckle the slope window
// below exists to stop. Both new shades are Tailwind steps, checked against
// each neighbour for colour blindness and for normal vision. The measurements:
// "the colour bands" row of SETTLED in context/session.md.
const SLOPE_STOPS: Array<{ maxSlopePct: number; color: string }> = [
  { maxSlopePct: -8, color: "#7c3aed" }, // very steep descent: purple
  { maxSlopePct: -3, color: "#2563eb" }, // steep descent: blue
  { maxSlopePct: 0, color: "#22c55e" }, // gentle descent: blue-green
  { maxSlopePct: 3, color: "#eab308" }, // gentle climb: green-yellow
  { maxSlopePct: 6, color: "#f97316" }, // moderate climb: yellow-orange
  { maxSlopePct: 9, color: "#dc2626" }, // steep climb: red
  { maxSlopePct: 12, color: "#881337" }, // very steep climb: dark red (rose-900)
  { maxSlopePct: Infinity, color: "#450a0a" }, // steepest climb: near-black red (red-950)
];

export function colorForSlope(slopePct: number): string {
  return SLOPE_STOPS.find((stop) => slopePct <= stop.maxSlopePct)!.color;
}

// The bands as data, for a client that labels them, so the app never holds a
// second copy of the table above. The open-ended top band's edge is null:
// JSON has no Infinity.
export function slopeBands(): Array<{ maxSlopePct: number | null; color: string }> {
  return SLOPE_STOPS.map(({ maxSlopePct, color }) => ({
    maxSlopePct: Number.isFinite(maxSlopePct) ? maxSlopePct : null,
    color,
  }));
}

// Buckets either side of the one being coloured that are folded into its
// slope estimate. A 15m bucket with ~0.15m of barometer noise gives roughly
// 1% of slope error from a plain difference of two points -- comparable to
// the width of a colour band, which is why a flat street came out speckled
// with oranges and blues. Fitting a line through ~5 buckets (a 60m span)
// averages that down, while staying short enough not to smear a real
// descent-to-climb transition that plays out over hundreds of metres.
const SLOPE_WINDOW = 2;

// No rideable street here approaches this, so anything steeper is a bad
// reading rather than terrain.
const MAX_PLAUSIBLE_SLOPE_PCT = 25;

export const clampSlope = (slopePct: number) =>
  Math.max(-MAX_PLAUSIBLE_SLOPE_PCT, Math.min(MAX_PLAUSIBLE_SLOPE_PCT, slopePct));

// The buckets folded into the slope of the piece after `index`: SLOPE_WINDOW
// before it, and SLOPE_WINDOW past the bucket that ends it.
function windowAround(sorted: ElevationBucket[], index: number): ElevationBucket[] {
  const lo = Math.max(0, index - SLOPE_WINDOW);
  const hi = Math.min(sorted.length - 1, index + SLOPE_WINDOW + 1);
  return sorted.slice(lo, hi + 1);
}

// Least-squares slope of elevation against distance, in percent and not yet
// clamped; null where there is no slope to fit.
function leastSquaresPct(points: ReadonlyArray<{ distanceM: number; elevationM: number }>): number | null {
  const n = points.length;
  if (n < 2) return null;
  const meanD = points.reduce((sum, b) => sum + b.distanceM, 0) / n;
  const meanE = points.reduce((sum, b) => sum + b.elevationM, 0) / n;

  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    const dd = point.distanceM - meanD;
    covariance += dd * (point.elevationM - meanE);
    variance += dd * dd;
  }
  if (variance === 0) return null;

  const slopePct = (covariance / variance) * 100;
  return Number.isFinite(slopePct) ? slopePct : null;
}

// Least-squares slope over the window's mean heights, in percent.
function slopeAt(sorted: ElevationBucket[], index: number): number {
  const slopePct = leastSquaresPct(windowAround(sorted, index));
  return slopePct === null ? 0 : clampSlope(slopePct);
}

// One direction's pass rows, by the bucket distance each was measured at.
type PassesAt = Map<number, Array<{ matchId: number; elevationM: number }>>;

// Whether every pass behind the window's means is on file: at each bucket, one
// pass row for every pass its mean holds. Rides merged before pass rows were
// kept are in the means and nowhere else, so until a rebuild files them the
// window is drawn from the means. Fitting the rows that do exist would let a
// newer ride outvote every pass that only the mean remembers.
function everyPassOnFile(window: ElevationBucket[], passesAt: PassesAt): boolean {
  return window.every((bucket) => (passesAt.get(bucket.distanceM)?.length ?? 0) === bucket.sampleCount);
}

// The slope from each pass's OWN heights: the mean of every pass's
// least-squares slope over the window, weighted by how many of the window's
// buckets it covers, from the passes covering two or more. Clamped after
// averaging, as the means' slope is, so passes that all cover the same buckets
// give exactly the means' slope: least squares is linear in the heights. Null
// when no pass covers two of the window's buckets, or when the average is not
// a number: each pass's slope is finite, but their sum can still overflow, and
// a NaN reaching colorForSlope throws, which would fail the whole map rather
// than one piece of it.
function perPassSlopeAt(window: ElevationBucket[], passesAt: PassesAt): number | null {
  const byPass = new Map<number, Array<{ distanceM: number; elevationM: number }>>();
  for (const bucket of window) {
    for (const { matchId, elevationM } of passesAt.get(bucket.distanceM) ?? []) {
      const points = byPass.get(matchId) ?? [];
      points.push({ distanceM: bucket.distanceM, elevationM });
      byPass.set(matchId, points);
    }
  }

  let weighted = 0;
  let weight = 0;
  for (const points of byPass.values()) {
    const slopePct = leastSquaresPct(points);
    if (slopePct === null) continue;
    weighted += slopePct * points.length;
    weight += points.length;
  }
  if (weight === 0) return null;
  const slopePct = weighted / weight;
  return Number.isFinite(slopePct) ? clampSlope(slopePct) : null;
}

// The slope the map draws for the piece after bucket `index`.
//
// From each pass's own heights wherever every pass is on file, because the
// means draw cliffs. Each ride is lined up with the terrain model by one
// offset and a barometer drifts during a ride, so two passes over the same
// ground can sit metres apart. Where they cover different stretches of a line,
// a mean changes membership from one bucket to the next and their level
// difference becomes a step the fit reads as a climb: the Ridgeway trailhead
// lot drew +25% on ground the terrain model puts at 3 to 6%. A pass's level
// cannot reach its own slope. Measured through ride 89 by `npm run
// eval:mixing`: judged against the terrain model, each pass's slope was 2.87
// points off where mixing had moved the colour, against 4.91 for the means,
// and 2.25 against 2.38 wherever two or more passes cover a piece.
function slopeFor(sorted: ElevationBucket[], index: number, passesAt: PassesAt): number {
  const window = windowAround(sorted, index);
  if (everyPassOnFile(window, passesAt)) {
    const perPass = perPassSlopeAt(window, passesAt);
    if (perPass !== null) return perPass;
  }
  return slopeAt(sorted, index);
}

// The slope of each piece of one direction's line, in percent: one per gap
// between consecutive buckets, in distance order. `sorted` is that direction's
// buckets sorted by distance, `passes` its pass rows.
//
// Exported for its tests; buildDirectionalGradientLines is the only caller.
export function pieceSlopesPct(sorted: ElevationBucket[], passes: readonly PassBucket[] = []): number[] {
  const passesAt: PassesAt = new Map();
  for (const { matchId, distanceM, elevationM } of passes) {
    const atDistance = passesAt.get(distanceM) ?? [];
    atDistance.push({ matchId, elevationM });
    passesAt.set(distanceM, atDistance);
  }
  return sorted.slice(0, -1).map((_, i) => slopeFor(sorted, i, passesAt));
}

export interface DirectionalGradientLine {
  direction: Direction;
  // Offset to one side of the street centreline, and clipped to the stretch
  // that was actually ridden -- see buildDirectionalGradientLines.
  geometry: GeoJSON.LineString;
  // Fractions are along `geometry` as given, not along the whole segment.
  colorStops: Array<{ distanceFraction: number; color: string }>;
}

// The stretch of one direction's line that gets drawn, in metres along its
// direction of travel, or null when that stretch is empty.
//
// Only draw the ground the ride actually covered. Painting the whole segment
// from partial coverage invented road: a rider who clipped 45m of a 129m
// footway beside East Fountain Boulevard got the full 129m drawn, 80m of it
// heading off into a park they never entered.
//
// Use the recorded extent where there is one. Falling back to the bucket
// positions understates coverage at the head by up to half a bucket, because a
// bucket sits at the centre of the ground it averages -- that left a ~7.5m hole
// at the start of most lines and read as a dashed route. The fallback only
// applies to rides recorded before coverage was tracked; a rebuild removes it.
//
// Exported because the press-and-hold path (pathGrowth.ts) has to agree with
// the map about where every line starts and stops.
export function drawnExtent(
  lengthM: number,
  firstBucketM: number,
  lastBucketM: number,
  coverage?: SegmentCoverage,
): { fromTravelM: number; toTravelM: number } | null {
  const fromTravelM = coverage
    ? Math.max(0, coverage.coveredFromM)
    : Math.max(0, firstBucketM - HALF_BUCKET_M);
  const toTravelM = coverage
    ? Math.min(lengthM, coverage.coveredToM)
    : Math.min(lengthM, lastBucketM + HALF_BUCKET_M);
  return toTravelM - fromTravelM > 0 ? { fromTravelM, toTravelM } : null;
}

// The stretch from `fromTravelM` to `toTravelM` (metres along `direction`) of
// the line drawn for that direction: offset to its side of the centreline, in
// the geometry's forward order. Offsetting a curve changes its length
// slightly, so travel distances are rescaled onto the offset line rather than
// used directly.
export function offsetTravelSlice(
  segment: Segment,
  direction: Direction,
  fromTravelM: number,
  toTravelM: number,
): GeoJSON.LineString {
  const centerline = turf.lineString(segment.geom.coordinates);
  const offsetSide = direction === "forward" ? OFFSET_M : -OFFSET_M;
  const offsetLine = turf.lineOffset(centerline, offsetSide, { units: "meters" });
  const offsetLengthM = turf.length(offsetLine, { units: "meters" });
  const scale = segment.lengthM > 0 ? offsetLengthM / segment.lengthM : 1;

  const forwardFromM = direction === "forward" ? fromTravelM : segment.lengthM - toTravelM;
  const forwardToM = direction === "forward" ? toTravelM : segment.lengthM - fromTravelM;
  return turf.lineSliceAlong(offsetLine, forwardFromM * scale, forwardToM * scale, {
    units: "meters",
  }).geometry;
}

// One colour stop of a drawn line, with the slope its colour was picked for.
export interface DrawnStop {
  distanceFraction: number;
  color: string;
  slopePct: number;
}

// Everything the map draws for one direction of a segment: the drawn extent,
// its geometry, and its colour stops sorted along the geometry, each carrying
// its slope. GET /segments sends the stops without the slope.
export interface LineDrawing {
  direction: Direction;
  fromTravelM: number;
  toTravelM: number;
  geometry: GeoJSON.LineString;
  stops: DrawnStop[];
}

// Two coordinate systems meet here and they run opposite ways for half the
// data. Bucket distances are measured *along the direction of travel*, so on a
// backward run distance 0 sits at the segment's far end, while the geometry is
// always in forward order. Everything below is computed in travel space and
// converted to a fraction of the drawn line at the last moment.
//
// `passes` holds each pass's own heights, from which the slope is fitted
// wherever every pass behind a window is on file (see slopeFor). With none,
// every piece is drawn from the means. Null when there is nothing to draw.
export function drawLine(
  segment: Segment,
  direction: Direction,
  buckets: readonly ElevationBucket[],
  coverage?: SegmentCoverage,
  passes?: readonly PassBucket[],
): LineDrawing | null {
  if (buckets.length === 0) return null;
  const sorted = [...buckets].sort((a, b) => a.distanceM - b.distanceM);

  const extent = drawnExtent(segment.lengthM, sorted[0].distanceM, sorted[sorted.length - 1].distanceM, coverage);
  if (extent === null) return null;
  const { fromTravelM, toTravelM } = extent;
  const drawnLengthM = toTravelM - fromTravelM;
  const geometry = offsetTravelSlice(segment, direction, fromTravelM, toTravelM);

  // Position along the *drawn* line. For a backward run the drawn line still
  // runs forward, so travel distance counts down across it. Bucket centres are
  // rounded onto a 15m grid and can land just outside the measured extent, so
  // fractions are clamped rather than trusted.
  const toFraction = (travelM: number) => {
    const raw =
      direction === "forward"
        ? (travelM - fromTravelM) / drawnLengthM
        : (toTravelM - travelM) / drawnLengthM;
    return Math.max(0, Math.min(1, raw));
  };

  // One colour per gap between buckets, spanning the whole drawn line: the
  // first runs back to where coverage starts and the last runs on to where it
  // ends, so there is no unpainted stub at either end.
  const slopes = pieceSlopesPct(sorted, passes);
  const spans =
    sorted.length === 1
      ? [{ startM: fromTravelM, endM: toTravelM, slopePct: 0 }]
      : sorted.slice(0, -1).map((bucket, i) => ({
          startM: i === 0 ? fromTravelM : bucket.distanceM,
          endM: i === sorted.length - 2 ? toTravelM : sorted[i + 1].distanceM,
          slopePct: slopes[i],
        }));

  const stops = spans
    .map(({ startM, endM, slopePct }) => ({
      distanceFraction: Math.min(toFraction(startM), toFraction(endM)),
      color: colorForSlope(slopePct),
      slopePct,
    }))
    .sort((a, b) => a.distanceFraction - b.distanceFraction);

  return { direction, fromTravelM, toTravelM, geometry, stops };
}

// Builds one offset, color-stopped line per direction for a segment. The two
// directions are offset to opposite sides of the centerline (in meters, via
// turf.lineOffset) so both are visible at once, and each direction's color
// stops are computed independently from its own elevation buckets -- so
// reversing direction on the same street naturally swaps which line (and
// which gradient) applies. Each line sits on the right-hand side of its own
// direction of travel: turf offsets a positive distance to the right.
//
// `passesByDirection` holds each pass's own heights; see drawLine.
export function buildDirectionalGradientLines(
  segment: Segment,
  bucketsByDirection: Record<Direction, ElevationBucket[]>,
  coverageByDirection: Partial<Record<Direction, SegmentCoverage>> = {},
  passesByDirection: Partial<Record<Direction, PassBucket[]>> = {},
): DirectionalGradientLine[] {
  return (Object.entries(bucketsByDirection) as Array<[Direction, ElevationBucket[]]>).flatMap(
    ([direction, buckets]) => {
      const drawing = drawLine(
        segment,
        direction,
        buckets,
        coverageByDirection[direction],
        passesByDirection[direction],
      );
      if (drawing === null) return [];
      return [
        {
          direction,
          geometry: drawing.geometry,
          colorStops: drawing.stops.map(({ distanceFraction, color }) => ({ distanceFraction, color })),
        },
      ];
    },
  );
}
