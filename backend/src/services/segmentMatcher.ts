import * as turf from "@turf/turf";
import type { Direction, MatchedRun, Segment, SessionSample } from "../types/index.js";

const MAX_MATCH_DISTANCE_M = 25;
const MAX_BEARING_DELTA_DEG = 45;

// A street and its separately-mapped sidewalk sit 5-10m apart -- well inside
// GPS error -- so picking the nearest candidate independently for every
// sample made a single pass down one street flip back and forth between
// them, scattering one ride across several parallel lines. Once a run is
// established, a rival segment has to be clearly closer (not just closer) to
// take over.
const SWITCH_MARGIN_M = 8;

// Fixes this loose can't tell one parallel way from another, so they'd only
// add noise. This rejects genuinely bad fixes rather than merely mediocre
// ones -- being too strict here would throw away most of an urban ride.
const MAX_ACCURACY_M = 30;

function bearingDelta(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function directionForBearing(sampleBearing: number, segmentBearing: number): Direction | null {
  if (bearingDelta(sampleBearing, segmentBearing) <= MAX_BEARING_DELTA_DEG) return "forward";
  if (bearingDelta(sampleBearing, (segmentBearing + 180) % 360) <= MAX_BEARING_DELTA_DEG) return "backward";
  return null;
}

interface Candidate {
  segment: Segment;
  direction: Direction;
  distanceM: number;
}

// Matches each sample to a segment and a direction of travel, then collapses
// consecutive same segment+direction samples into runs.
//
// This is a prototype-grade heuristic (nearest-segment + bearing check +
// hysteresis), not a full map-matching HMM -- it can still misfire at complex
// intersections. Good enough to keep one ride on one line; revisit with a
// proper map-matcher (e.g. Valhalla's Meili) if that stops holding.
export function matchSamplesToSegments(
  samples: SessionSample[],
  candidateSegments: Segment[],
): MatchedRun[] {
  const lines = new Map(candidateSegments.map((s) => [s.id, turf.lineString(s.geom.coordinates)]));
  const runs: MatchedRun[] = [];
  let current: MatchedRun | null = null;

  for (const sample of samples) {
    if (sample.headingDeg == null || sample.headingDeg < 0) continue;
    if (sample.accuracyM != null && sample.accuracyM > MAX_ACCURACY_M) continue;

    const point = turf.point([sample.lon, sample.lat]);
    const candidates: Candidate[] = [];

    for (const segment of candidateSegments) {
      const distanceM = turf.pointToLineDistance(point, lines.get(segment.id)!, { units: "meters" });
      if (distanceM > MAX_MATCH_DISTANCE_M) continue;
      const direction = directionForBearing(sample.headingDeg, segment.bearingDeg);
      if (!direction) continue;
      candidates.push({ segment, direction, distanceM });
    }

    if (candidates.length === 0) {
      current = null;
      continue;
    }

    let best = candidates[0];
    for (const candidate of candidates) {
      if (candidate.distanceM < best.distanceM) best = candidate;
    }

    // Stay on the run's current segment unless something is decisively
    // closer. Candidates are already filtered by bearing, so a genuine turn
    // onto another street drops the old segment from the list entirely and
    // this can't wrongly hold on to it.
    if (current) {
      const staying = candidates.find(
        (c) => c.segment.id === current!.segmentId && c.direction === current!.direction,
      );
      if (staying && staying.distanceM <= best.distanceM + SWITCH_MARGIN_M) {
        current.samples.push(sample);
        continue;
      }
    }

    current = { segmentId: best.segment.id, direction: best.direction, samples: [sample] };
    runs.push(current);
  }

  return runs;
}
