import * as turf from "@turf/turf";
import { BUCKET_SIZE_M } from "./elevationAggregator.js";
import type { Direction, ElevationBucket, Segment, SegmentCoverage } from "../types/index.js";

const OFFSET_M = 4;

// A bucket is the average of samples within half a bucket either side of its
// centre, so the ground a set of buckets actually covers runs from half a
// bucket before the first to half a bucket after the last.
const HALF_BUCKET_M = BUCKET_SIZE_M / 2;

// Slope (%) -> color stops. Descending goes purple (steepest) -> blue ->
// green, climbing goes green -> yellow -> orange -> red, matching the
// reference photo.
const SLOPE_STOPS: Array<{ maxSlopePct: number; color: string }> = [
  { maxSlopePct: -8, color: "#7c3aed" }, // very steep descent: purple
  { maxSlopePct: -3, color: "#2563eb" }, // steep descent: blue
  { maxSlopePct: 0, color: "#22c55e" }, // gentle descent: blue-green
  { maxSlopePct: 3, color: "#eab308" }, // gentle climb: green-yellow
  { maxSlopePct: 6, color: "#f97316" }, // moderate climb: yellow-orange
  { maxSlopePct: Infinity, color: "#dc2626" }, // steep climb: red
];

function colorForSlope(slopePct: number): string {
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

// Least-squares slope of elevation against distance over the window around
// `index`, in percent.
function slopeAt(sorted: ElevationBucket[], index: number): number {
  const lo = Math.max(0, index - SLOPE_WINDOW);
  const hi = Math.min(sorted.length - 1, index + SLOPE_WINDOW + 1);
  const window = sorted.slice(lo, hi + 1);
  if (window.length < 2) return 0;

  const n = window.length;
  const meanD = window.reduce((sum, b) => sum + b.distanceM, 0) / n;
  const meanE = window.reduce((sum, b) => sum + b.elevationM, 0) / n;

  let covariance = 0;
  let variance = 0;
  for (const bucket of window) {
    const dd = bucket.distanceM - meanD;
    covariance += dd * (bucket.elevationM - meanE);
    variance += dd * dd;
  }
  if (variance === 0) return 0;

  const slopePct = (covariance / variance) * 100;
  if (!Number.isFinite(slopePct)) return 0;
  return Math.max(-MAX_PLAUSIBLE_SLOPE_PCT, Math.min(MAX_PLAUSIBLE_SLOPE_PCT, slopePct));
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
export function buildDirectionalGradientLines(
  segment: Segment,
  bucketsByDirection: Record<Direction, ElevationBucket[]>,
  coverageByDirection: Partial<Record<Direction, SegmentCoverage>> = {},
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
      const spans =
        sorted.length === 1
          ? [{ startM: fromTravelM, endM: toTravelM, color: colorForSlope(0) }]
          : sorted.slice(0, -1).map((bucket, i) => ({
              startM: i === 0 ? fromTravelM : bucket.distanceM,
              endM: i === sorted.length - 2 ? toTravelM : sorted[i + 1].distanceM,
              color: colorForSlope(slopeAt(sorted, i)),
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
