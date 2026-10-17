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

const clampSlope = (slopePct: number) =>
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
// when no pass covers two of the window's buckets.
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
  return weight === 0 ? null : clampSlope(weighted / weight);
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

// Builds one offset, color-stopped line per direction for a segment. The two
// directions are offset to opposite sides of the centerline (in meters, via
// turf.lineOffset) so both are visible at once, and each direction's color
// stops are computed independently from its own elevation buckets -- so
// reversing direction on the same street naturally swaps which line (and
// which gradient) applies.
//
// Two coordinate systems meet here and they run opposite ways for half the
// data. Bucket distances are measured *along the direction of travel*, so on a
// backward run distance 0 sits at the segment's far end, while the geometry is
// always in forward order. Everything below is computed in travel space and
// converted to a fraction of the drawn line at the last moment.
//
// `passesByDirection` holds each pass's own heights, from which the slope is
// fitted wherever every pass behind a window is on file (see slopeFor). With
// none, every piece is drawn from the means.
export function buildDirectionalGradientLines(
  segment: Segment,
  bucketsByDirection: Record<Direction, ElevationBucket[]>,
  coverageByDirection: Partial<Record<Direction, SegmentCoverage>> = {},
  passesByDirection: Partial<Record<Direction, PassBucket[]>> = {},
): DirectionalGradientLine[] {
  const centerline = turf.lineString(segment.geom.coordinates);

  return (Object.entries(bucketsByDirection) as Array<[Direction, ElevationBucket[]]>)
    .filter(([, buckets]) => buckets.length > 0)
    .flatMap(([direction, buckets]) => {
      const sorted = [...buckets].sort((a, b) => a.distanceM - b.distanceM);

      // Only draw the ground the ride actually covered. Painting the whole
      // segment from partial coverage invented road: a rider who clipped 45m
      // of a 129m footway beside East Fountain Boulevard got the full 129m
      // drawn, 80m of it heading off into a park they never entered.
      //
      // Use the recorded extent where there is one. Falling back to the bucket
      // positions understates coverage at the head by up to half a bucket,
      // because a bucket sits at the centre of the ground it averages -- that
      // left a ~7.5m hole at the start of most lines and read as a dashed
      // route. The fallback only applies to rides recorded before coverage was
      // tracked; a rebuild removes it.
      const coverage = coverageByDirection[direction];
      const fromTravelM = coverage
        ? Math.max(0, coverage.coveredFromM)
        : Math.max(0, sorted[0].distanceM - HALF_BUCKET_M);
      const toTravelM = coverage
        ? Math.min(segment.lengthM, coverage.coveredToM)
        : Math.min(segment.lengthM, sorted[sorted.length - 1].distanceM + HALF_BUCKET_M);
      const drawnLengthM = toTravelM - fromTravelM;
      if (drawnLengthM <= 0) return [];

      const offsetSide = direction === "forward" ? OFFSET_M : -OFFSET_M;
      const offsetLine = turf.lineOffset(centerline, offsetSide, { units: "meters" });
      // Offsetting a curve changes its length slightly, so travel distances
      // are rescaled onto the offset line rather than used directly.
      const offsetLengthM = turf.length(offsetLine, { units: "meters" });
      const scale = segment.lengthM > 0 ? offsetLengthM / segment.lengthM : 1;

      const forwardFromM = direction === "forward" ? fromTravelM : segment.lengthM - toTravelM;
      const forwardToM = direction === "forward" ? toTravelM : segment.lengthM - fromTravelM;
      const clipped = turf.lineSliceAlong(offsetLine, forwardFromM * scale, forwardToM * scale, {
        units: "meters",
      });

      // Position along the *drawn* line. For a backward run the drawn line
      // still runs forward, so travel distance counts down across it. Bucket
      // centres are rounded onto a 15m grid and can land just outside the
      // measured extent, so fractions are clamped rather than trusted.
      const toFraction = (travelM: number) => {
        const raw =
          direction === "forward"
            ? (travelM - fromTravelM) / drawnLengthM
            : (toTravelM - travelM) / drawnLengthM;
        return Math.max(0, Math.min(1, raw));
      };

      // One colour per gap between buckets, spanning the whole drawn line: the
      // first runs back to where coverage starts and the last runs on to where
      // it ends, so there is no unpainted stub at either end.
      const slopes = pieceSlopesPct(sorted, passesByDirection[direction]);
      const spans =
        sorted.length === 1
          ? [{ startM: fromTravelM, endM: toTravelM, color: colorForSlope(0) }]
          : sorted.slice(0, -1).map((bucket, i) => ({
              startM: i === 0 ? fromTravelM : bucket.distanceM,
              endM: i === sorted.length - 2 ? toTravelM : sorted[i + 1].distanceM,
              color: colorForSlope(slopes[i]),
            }));

      const colorStops = spans
        .map(({ startM, endM, color }) => ({
          distanceFraction: Math.min(toFraction(startM), toFraction(endM)),
          color,
        }))
        .sort((a, b) => a.distanceFraction - b.distanceFraction);

      return [{ direction, geometry: clipped.geometry, colorStops }];
    });
}
