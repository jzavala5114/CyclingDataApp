import * as turf from "@turf/turf";
import type { Direction, ElevationBucket, Segment } from "../types/index.js";

const OFFSET_M = 4;

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
    .filter(([, buckets]) => buckets.length >= 2)
    .map(([direction, buckets]) => {
      const sorted = [...buckets].sort((a, b) => a.distanceM - b.distanceM);
      const offsetSide = direction === "forward" ? OFFSET_M : -OFFSET_M;
      const offsetLine = turf.lineOffset(centerline, offsetSide, { units: "meters" });

      const colorStops = sorted.slice(0, -1).map((bucket, i) => {
        const next = sorted[i + 1];
        const rise = next.elevationM - bucket.elevationM;
        const run = next.distanceM - bucket.distanceM;
        const slopePct = run > 0 ? (rise / run) * 100 : 0;
        return {
          distanceFraction: bucket.distanceM / segment.lengthM,
          color: colorForSlope(slopePct),
        };
      });

      return { direction, geometry: offsetLine.geometry, colorStops };
    });
}
