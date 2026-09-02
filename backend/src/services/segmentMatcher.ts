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

// Result-preserving prefilter. The distance from a point to a segment's
// bounding box is a lower bound on its distance to the segment, so a point
// outside the padded box cannot be within MAX_MATCH_DISTANCE_M of the line and
// can be rejected on four comparisons instead of a walk along the geometry.
// A ride's bbox holds thousands of candidate segments and every sample is
// tested against all of them, so this is most of the matcher's cost.
//
// 0.0005 degrees is ~56m of latitude and ~43m of longitude at 39 degrees N,
// both comfortably beyond the 25m threshold, so the padding cannot discard a
// segment that would have matched.
const PREFILTER_PAD_DEG = 0.0005;

// The bearing test asks "is this rider travelling along this segment?", and it
// used to ask it of `segment.bearingDeg` -- the straight line from one end of
// the segment to the other. On a street that line *is* the street. On a
// switchback it describes no part of the trail: a rider correctly on the
// segment can be heading 90 degrees away from its chord, so the segment is
// dropped from the candidate list, the run ends, and one traversal arrives as
// fragments. That is the mechanism behind singletrack discarding ~33% of runs
// against 16% on streets.
//
// Comparing against the tangent where the rider actually is asks the same
// question, with the same MAX_BEARING_DELTA_DEG tolerance, of the right piece
// of geometry. No threshold moves, and nothing is loosened: a rider heading
// along the chord but across the local tangent is now correctly rejected.
//
// Measured over a window rather than taken from the single OSM edge under the
// point, because trail geometry is digitised at metre scale and one edge's
// bearing is mostly digitising noise. 10m either side is comparable to the
// ~11m fix spacing, so the tangent describes the same stretch of ground the
// rider's own heading was derived from. The result is insensitive to it:
// doubling it to 20m moved the bucket count by 4 in 5000.
export const TANGENT_WINDOW_M = 10;

const M_PER_DEG_LAT = 111320;

function bearingDelta(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function directionForBearing(sampleBearing: number, segmentBearing: number): Direction | null {
  if (bearingDelta(sampleBearing, segmentBearing) <= MAX_BEARING_DELTA_DEG) return "forward";
  if (bearingDelta(sampleBearing, (segmentBearing + 180) % 360) <= MAX_BEARING_DELTA_DEG) return "backward";
  return null;
}

// One straight piece of a segment's polyline, carrying the tangent of the
// stretch of trail around it. Precomputed per segment because it does not
// depend on the sample, which keeps the per-fix work to arithmetic.
interface Edge {
  alon: number;
  alat: number;
  blon: number;
  blat: number;
  tangentDeg: number;
}

interface SegmentGeometry {
  edges: Edge[];
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

function buildSegmentGeometry(segment: Segment, tangentWindowM: number): SegmentGeometry {
  const coords = segment.geom.coordinates as [number, number][];
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) {
    cumulative.push(cumulative[i - 1] + turf.distance(coords[i - 1], coords[i], { units: "meters" }));
  }
  const totalM = cumulative[cumulative.length - 1];

  // Point at a distance along the polyline, by interpolation between vertices.
  const pointAt = (distanceM: number): [number, number] => {
    const d = Math.max(0, Math.min(totalM, distanceM));
    let lo = 1;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    const span = cumulative[lo] - cumulative[lo - 1];
    const t = span > 0 ? (d - cumulative[lo - 1]) / span : 0;
    return [
      coords[lo - 1][0] + (coords[lo][0] - coords[lo - 1][0]) * t,
      coords[lo - 1][1] + (coords[lo][1] - coords[lo - 1][1]) * t,
    ];
  };

  const edges: Edge[] = [];
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (let i = 1; i < coords.length; i++) {
    const [alon, alat] = coords[i - 1];
    const [blon, blat] = coords[i];
    minLon = Math.min(minLon, alon, blon);
    maxLon = Math.max(maxLon, alon, blon);
    minLat = Math.min(minLat, alat, blat);
    maxLat = Math.max(maxLat, alat, blat);

    let tangentDeg = segment.bearingDeg;
    if (tangentWindowM > 0) {
      const mid = (cumulative[i - 1] + cumulative[i]) / 2;
      const from = pointAt(mid - tangentWindowM);
      const to = pointAt(mid + tangentWindowM);
      // A window that collapses -- a segment shorter than the window's own
      // resolution -- would give a meaningless bearing, so keep the chord.
      if (turf.distance(from, to, { units: "meters" }) >= 1) {
        tangentDeg = (turf.bearing(from, to) + 360) % 360;
      }
    }
    edges.push({ alon, alat, blon, blat, tangentDeg });
  }

  return {
    edges,
    minLon: minLon - PREFILTER_PAD_DEG,
    minLat: minLat - PREFILTER_PAD_DEG,
    maxLon: maxLon + PREFILTER_PAD_DEG,
    maxLat: maxLat + PREFILTER_PAD_DEG,
  };
}

// Distance from a fix to one edge, on a local equirectangular projection. Over
// the tens of metres this matcher cares about the distortion is far below GPS
// noise, and it avoids allocating a turf feature per edge per fix.
function pointToEdgeM(lat: number, lon: number, edge: Edge, cosLat: number): number {
  const ax = (edge.alon - lon) * M_PER_DEG_LAT * cosLat;
  const ay = (edge.alat - lat) * M_PER_DEG_LAT;
  const bx = (edge.blon - lon) * M_PER_DEG_LAT * cosLat;
  const by = (edge.blat - lat) * M_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// The nearest point on a segment whose tangent agrees with where the rider is
// going -- not simply the nearest point.
//
// The distinction only matters where a segment doubles back on itself, and
// there it decides the match. On a switchback the neighbouring leg can be
// closer than the one you are riding, and its tangent points roughly backwards:
// snapping to the nearest point picked that leg, failed the bearing test, ended
// the run, and cost real traversals -- 116m of a 140m stretch of Gold Camp
// Road, 80m of Chamberlain, 74m of Ladders. Asking each edge in turn lets the
// leg you are actually on win, because it is both near and aligned.
function nearestAlignedEdge(
  sample: SessionSample,
  geometry: SegmentGeometry,
  cosLat: number,
): { distanceM: number; direction: Direction } | null {
  let bestDistanceM = Infinity;
  let bestDirection: Direction | null = null;

  for (const edge of geometry.edges) {
    const distanceM = pointToEdgeM(sample.lat, sample.lon, edge, cosLat);
    // Cheap tests first: an edge that cannot win needs no bearing check.
    if (distanceM > MAX_MATCH_DISTANCE_M || distanceM >= bestDistanceM) continue;
    const direction = directionForBearing(sample.headingDeg!, edge.tangentDeg);
    if (!direction) continue;
    bestDistanceM = distanceM;
    bestDirection = direction;
  }

  return bestDirection ? { distanceM: bestDistanceM, direction: bestDirection } : null;
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
// `tangentWindowM` of 0 or less compares against the segment chord, which is
// the behaviour this replaced. Kept as a parameter so the two can be measured
// against each other through this exact code path rather than a reimplementation.
export function matchSamplesToSegments(
  samples: SessionSample[],
  candidateSegments: Segment[],
  tangentWindowM: number = TANGENT_WINDOW_M,
): MatchedRun[] {
  const geometries = new Map(
    candidateSegments.map((s) => [s.id, buildSegmentGeometry(s, tangentWindowM)]),
  );
  const runs: MatchedRun[] = [];
  let current: MatchedRun | null = null;

  for (const sample of samples) {
    if (sample.headingDeg == null || sample.headingDeg < 0) continue;
    if (sample.accuracyM != null && sample.accuracyM > MAX_ACCURACY_M) continue;

    const cosLat = Math.cos((sample.lat * Math.PI) / 180);
    const candidates: Candidate[] = [];

    for (const segment of candidateSegments) {
      const geometry = geometries.get(segment.id)!;
      if (
        sample.lon < geometry.minLon || sample.lon > geometry.maxLon ||
        sample.lat < geometry.minLat || sample.lat > geometry.maxLat
      ) {
        continue;
      }
      const hit = nearestAlignedEdge(sample, geometry, cosLat);
      if (!hit) continue;
      candidates.push({ segment, direction: hit.direction, distanceM: hit.distanceM });
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
