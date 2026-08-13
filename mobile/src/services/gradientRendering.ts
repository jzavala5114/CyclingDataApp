import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, LineString } from "geojson";
import type { SegmentWithGradients } from "../types";

export interface ColoredLineProperties {
  color: string;
  streetName: string | null;
}

// Slices each directional gradient line into short, solid-color pieces at
// its color stops -- @maplibre/maplibre-react-native's line-gradient
// support is still maturing, so per-piece coloring (many short LineLayer
// features styled by a `color` property) is the more reliable prototype
// approach. Revisit with a true `line-gradient` paint expression once that's
// verified stable on both platforms.
export function buildColoredLineFeatures(
  segments: SegmentWithGradients[],
): FeatureCollection<LineString, ColoredLineProperties> {
  const features: Array<Feature<LineString, ColoredLineProperties>> = [];

  for (const segment of segments) {
    for (const line of segment.directionalLines) {
      if (line.colorStops.length === 0) continue;

      const fullLine = turf.lineString(line.geometry.coordinates);
      const totalLengthM = turf.length(fullLine, { units: "meters" });
      const stops = [...line.colorStops, { distanceFraction: 1, color: line.colorStops.at(-1)!.color }];

      for (let i = 0; i < stops.length - 1; i++) {
        const startM = stops[i].distanceFraction * totalLengthM;
        const endM = stops[i + 1].distanceFraction * totalLengthM;
        if (endM <= startM) continue;

        const piece = turf.lineSliceAlong(fullLine, startM, endM, { units: "meters" });
        features.push(
          turf.feature(piece.geometry, {
            color: stops[i].color,
            streetName: segment.streetName,
          }),
        );
      }
    }
  }

  return turf.featureCollection(features);
}
