import * as turf from "@turf/turf";
import type { Direction, MatchedRun, Segment, SessionSample } from "../types/index.js";

const MAX_MATCH_DISTANCE_M = 25;
const MAX_BEARING_DELTA_DEG = 45;

function bearingDelta(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function directionForBearing(sampleBearing: number, segmentBearing: number): Direction | null {
  if (bearingDelta(sampleBearing, segmentBearing) <= MAX_BEARING_DELTA_DEG) return "forward";
  if (bearingDelta(sampleBearing, (segmentBearing + 180) % 360) <= MAX_BEARING_DELTA_DEG) return "backward";
  return null;
}

// Matches each sample to the nearest candidate segment within
// MAX_MATCH_DISTANCE_M, disambiguated by comparing the rider's heading to
// the segment's stored bearing, then collapses consecutive same
// segment+direction samples into runs.
//
// This is a prototype-grade heuristic (nearest-segment + bearing check), not
// a full map-matching HMM -- it will misfire at complex intersections or
// when GPS heading is noisy at low speed. Good enough to get gradients
// rendering; revisit with a proper map-matcher (e.g. Valhalla's Meili) once
// the data model is proven out.
export function matchSamplesToSegments(
  samples: SessionSample[],
  candidateSegments: Segment[],
): MatchedRun[] {
  const runs: MatchedRun[] = [];
  let current: MatchedRun | null = null;

  for (const sample of samples) {
    if (sample.headingDeg == null) continue;

    const point = turf.point([sample.lon, sample.lat]);
    let best: { segment: Segment; distanceM: number } | null = null;

    for (const segment of candidateSegments) {
      const line = turf.lineString(segment.geom.coordinates);
      const distanceM = turf.pointToLineDistance(point, line, { units: "meters" });
      if (distanceM <= MAX_MATCH_DISTANCE_M && (!best || distanceM < best.distanceM)) {
        best = { segment, distanceM };
      }
    }

    if (!best) {
      current = null;
      continue;
    }

    const direction = directionForBearing(sample.headingDeg, best.segment.bearingDeg);
    if (!direction) {
      current = null;
      continue;
    }

    if (current && current.segmentId === best.segment.id && current.direction === direction) {
      current.samples.push(sample);
    } else {
      current = { segmentId: best.segment.id, direction, samples: [sample] };
      runs.push(current);
    }
  }

  return runs;
}
