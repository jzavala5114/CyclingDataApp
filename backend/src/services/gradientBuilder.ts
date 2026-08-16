import * as turf from "@turf/turf";
import { BUCKET_SIZE_M } from "./elevationAggregator.js";
import type { Direction, ElevationBucket, Segment } from "../types/index.js";

const OFFSET_M = 4;

// One bucket is an elevation with no slope attached, so the whole segment gets
// painted a single flat colour. On a short connector that is honest -- the
// bucket really does span the segment. On a 139m street it is one reading
// stretched over a block, which is how South Institute Street ended up with a
// full-length green line off 4.7m of travel.
//
// The traversal gate in elevationAggregator stops runs like that reaching the
// model at all; this is the backstop for anything already stored, and for a
// segment that only ever collects a lone bucket.
const SINGLE_BUCKET_MAX_LENGTH_M = 2 * BUCKET_SIZE_M;

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
  geometry: GeoJSON.LineString; // offset to one side of the street centerline
  colorStops: Array<{ distanceFraction: number; color: string }>;
}

// Builds one offset, color-stopped line per direction for a segment. The two
// directions are offset to opposite sides of the centerline (in meters, via
// turf.lineOffset) so both are visible at once, and each direction's color
// stops are computed independently from its own elevation buckets -- so
// reversing direction on the same street naturally swaps which line (and
// which gradient) applies.
export function buildDirectionalGradientLines(
  segment: Segment,
  bucketsByDirection: Record<Direction, ElevationBucket[]>,
): DirectionalGradientLine[] {
  const centerline = turf.lineString(segment.geom.coordinates);

  return (Object.entries(bucketsByDirection) as Array<[Direction, ElevationBucket[]]>)
    .filter(
      ([, buckets]) =>
        buckets.length >= 2 ||
        (buckets.length === 1 && segment.lengthM <= SINGLE_BUCKET_MAX_LENGTH_M),
    )
    .map(([direction, buckets]) => {
      const sorted = [...buckets].sort((a, b) => a.distanceM - b.distanceM);
      const offsetSide = direction === "forward" ? OFFSET_M : -OFFSET_M;
      const offsetLine = turf.lineOffset(centerline, offsetSide, { units: "meters" });

      // A rider almost never drops a sample exactly on a segment's first
      // bucket, so the earliest bucket typically sits ~15m in. Anchoring the
      // first colour stop there left an unpainted stub at the head of every
      // segment, which read as a dashed line once segments were chained
      // together. The first stop is pinned to the start of the segment
      // instead, and the renderer already extends the last stop to the end.
      const colorStops =
        sorted.length === 1
          ? // A lone bucket on a segment short enough to have survived the
            // filter above: no slope to derive, so paint it flat rather than
            // punching a hole in the middle of a route.
            [{ distanceFraction: 0, color: colorForSlope(0) }]
          : sorted.slice(0, -1).map((bucket, i) => ({
              distanceFraction: i === 0 ? 0 : bucket.distanceM / segment.lengthM,
              color: colorForSlope(slopeAt(sorted, i)),
            }));

      return { direction, geometry: offsetLine.geometry, colorStops };
    });
}
