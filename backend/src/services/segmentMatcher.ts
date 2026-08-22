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

// A traversal broken into pieces is still one traversal.
//
// matchSamplesToSegments ends a run the moment a fix fails to match: a dropped
// fix, a burst of multipath, or -- on a switchback -- a heading that swings
// further than MAX_BEARING_DELTA_DEG from the segment's straight-line bearing.
// On a street grid that is rare. On mountain singletrack it is constant: one
// 146m descent of the BeaUTEiful Loop arrived as five runs of 1-15m each, and
// because every piece was shorter than the traversal gate's minimum, the entire
// descent was thrown away.
//
// Rejoining them needs a test that separates a broken traversal from two
// genuinely separate crossings of the same block -- which must stay separate,
// or a rider looping a block would stitch two touches at opposite ends into a
// full-length phantom. Time is that test. Measured across every ride recorded
// so far, fragments of one traversal are 0-45s apart (49 of 51 cases) while
// separate crossings are 90s or more apart, with nothing in between.
export const STITCH_WINDOW_S = 45;

export function stitchFragmentedRuns(
  runs: MatchedRun[],
  windowS: number = STITCH_WINDOW_S,
): MatchedRun[] {
  const stitched: MatchedRun[] = [];
  // The most recent run for each segment+direction, so a later fragment can be
  // appended to it. Appending advances its end time, which is what lets a
  // traversal broken into five pieces chain back together rather than only
  // rejoining pairs.
  const openByKey = new Map<string, MatchedRun>();

  for (const run of runs) {
    if (run.samples.length === 0) continue;
    const key = `${run.segmentId}|${run.direction}`;
    const open = openByKey.get(key);

    if (open) {
      const previousEndMs = Date.parse(open.samples[open.samples.length - 1].recordedAt);
      const thisStartMs = Date.parse(run.samples[0].recordedAt);
      if ((thisStartMs - previousEndMs) / 1000 <= windowS) {
        // The samples between the two fragments matched somewhere else, or
        // nowhere, and are deliberately left out -- only the pieces that were
        // matched to this segment contribute elevation. The extremes still
        // bracket the whole traversal, which is what the gate measures.
        open.samples.push(...run.samples);
        continue;
      }
    }

    // Copied rather than reused, so appending never mutates the caller's runs.
    const fresh: MatchedRun = { ...run, samples: [...run.samples] };
    stitched.push(fresh);
    openByKey.set(key, fresh);
  }

  return stitched;
}
