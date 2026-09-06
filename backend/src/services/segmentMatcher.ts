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

// The network is a graph, and until now the matcher never looked at it.
//
// Every canonical segment already carries the OSM node ids of its two ends, so
// which segments physically touch is known and was going unread. Each fix was
// decided on its own -- nearest aligned segment, with a reluctance to leave the
// current one -- and nothing checked that the resulting sequence was a route a
// bicycle could take. Measured across sessions 62-72, 37 of 365 consecutive run
// transitions joined two segments that do not touch, 30 of them within ten
// seconds of each other.
//
// The teleport is not the damage. What it costs is the ground underneath it: a
// ride down Hancock Expressway stepped onto two unnamed paths beside the road
// for a few seconds each, so the road pieces under those fixes went unmatched,
// and the paths' own runs were too short to clear the traversal gate. The
// result was a 191m hole in a continuously ridden road, with drawn pieces of
// the same carriageway on both sides of it.
//
// Half of that particular hole is not this file's to fix. Both of those paths
// are tagged footway=sidewalk and should never have been match candidates at
// all -- link_canonical.mjs missed them, along with 2,643 other tagged
// sidewalks, because its parallel test compares chord bearings and one of them
// misses by a single degree. This closes the first 100m, where the road piece
// is a genuine neighbour and the sidewalk is not. The rest stays open until the
// sidewalk stops competing.
//
// A candidate that does not touch where the rider just was now has to be
// clearly closer to win, exactly as SWITCH_MARGIN_M makes leaving the current
// segment cost something. Deliberately a penalty and not a veto: when no
// candidate is connected -- a real gap in OSM, the first fix of a ride, a rider
// crossing a car park -- every candidate carries the same penalty, it cancels
// out of the comparison, and the matcher behaves exactly as it did before.
//
// 6m, and the ceiling is what sets it rather than the floor. Swept over every
// session the model uses, the impossible-transition rate falls 10.1% -> 8.2%
// by 6m and then stalls; 10m buys another 0.9 points and 25m nothing at all
// beyond that, because by 25m the penalty exceeds MAX_MATCH_DISTANCE_M and has
// quietly become the veto this is not supposed to be.
//
// What rules out the larger values is the damage above 8m. At 10m a descent of
// Ladders in session 54 loses 23 of its fixes to Upper Chutes, a different
// trail that touches it at one end and diverges to 90m: a clean 110m traversal
// becomes 29m. The matcher takes one wrong turn, and connectivity -- which has
// no way to look back and see that the turn was wrong -- then holds it there.
// That is the ceiling of a greedy rule, not a number that wants tuning, and it
// is the argument for Viterbi if this ever needs to go further.
//
// At 6m nothing regresses: Ladders keeps 32 backward and 30 fixes forward
// against 32 and 31 before, and covered distance across the archive is flat
// (98.78km -> 98.81km) while buckets move by 0.35%.
const DISCONNECT_PENALTY_M = 6;

// How long the last matched segment keeps vouching for its neighbours.
//
// A fix that matches nothing does not clear the anchor: the rider has not
// stopped existing, and a dropped fix or a burst of multipath is precisely when
// the next fix most needs to be held to a route. But after a long silence they
// really could be anywhere, and a stale anchor would drag the ride back towards
// a street it left minutes ago. At ~11m fix spacing this is a couple of fixes'
// worth of gap, which is the shape a dropout has.
const ANCHOR_MAX_GAP_S = 15;

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

// Two segments cut from the same over-long run. The pipeline caps a run at
// 150m by slicing it, and every slice keeps the *run's* pair of end nodes, so
// they are distinguished only by piece_index.
function areCapSlicesOfOneRun(a: Segment, b: Segment): boolean {
  if (a.osmWayId !== b.osmWayId) return false;
  return (
    (a.startNodeId === b.startNodeId && a.endNodeId === b.endNodeId) ||
    (a.startNodeId === b.endNodeId && a.endNodeId === b.startNodeId)
  );
}

// segment id -> the ids of the segments that physically touch it.
//
// Sharing an OSM node is the test, with one exception the schema forces. Since
// every slice of a capped run carries that run's end nodes, node identity alone
// would call slice 0 and slice 9 neighbours across 1.4km of street. Inside one
// such family the neighbours are the slices either side, by piece_index.
//
// The same quirk leaves a middle slice looking connected to the cross streets
// at both ends of its run. That is left alone: those streets are hundreds of
// metres away, and MAX_MATCH_DISTANCE_M has already dropped them long before
// anything asks whether they are reachable.
//
// Built per call from the segments the caller is matching against, which is a
// box around one ride. Nothing is cached between rides: the graph is cheap
// beside the per-fix geometry, and a stale one would be a silent wrong answer.
function buildAdjacency(segments: Segment[]): Map<number, Set<number>> {
  const byNode = new Map<number, Segment[]>();
  for (const segment of segments) {
    for (const node of [segment.startNodeId, segment.endNodeId]) {
      const touching = byNode.get(node);
      if (touching) touching.push(segment);
      else byNode.set(node, [segment]);
    }
  }

  const adjacency = new Map<number, Set<number>>();
  const link = (from: number, to: number) => {
    const set = adjacency.get(from);
    if (set) set.add(to);
    else adjacency.set(from, new Set([to]));
  };

  for (const touching of byNode.values()) {
    for (let i = 0; i < touching.length; i++) {
      for (let j = i + 1; j < touching.length; j++) {
        const a = touching[i];
        const b = touching[j];
        if (areCapSlicesOfOneRun(a, b) && Math.abs(a.pieceIndex - b.pieceIndex) !== 1) continue;
        link(a.id, b.id);
        link(b.id, a.id);
      }
    }
  }

  return adjacency;
}

interface Candidate {
  segment: Segment;
  direction: Direction;
  distanceM: number;
  // distanceM, plus DISCONNECT_PENALTY_M when this segment does not touch where
  // the rider just was. Ranking uses this; the 25m gate that admitted the
  // candidate in the first place used the true distance.
  scoreM: number;
}

// Matches each sample to a segment and a direction of travel, then collapses
// consecutive same segment+direction samples into runs.
//
// This is a prototype-grade heuristic (nearest-segment + bearing check +
// connectivity preference + hysteresis), not a full map-matching HMM. It is
// greedy: each fix is decided once, in order, and a wrong turn taken early
// cannot be revised in the light of what came after. Viterbi over the whole
// ride is what would fix that, and is deliberately not here yet.
//
// `tangentWindowM` of 0 or less compares against the segment chord, and
// `disconnectPenaltyM` of 0 ignores the network graph. Both are the behaviour
// each replaced, kept as options so the alternatives can be measured through
// this exact code path rather than through a reimplementation of it.
export function matchSamplesToSegments(
  samples: SessionSample[],
  candidateSegments: Segment[],
  {
    tangentWindowM = TANGENT_WINDOW_M,
    disconnectPenaltyM = DISCONNECT_PENALTY_M,
  }: { tangentWindowM?: number; disconnectPenaltyM?: number } = {},
): MatchedRun[] {
  const geometries = new Map(
    candidateSegments.map((s) => [s.id, buildSegmentGeometry(s, tangentWindowM)]),
  );
  const adjacency = buildAdjacency(candidateSegments);
  const runs: MatchedRun[] = [];
  let current: MatchedRun | null = null;
  // The last segment a fix was matched to, and when. Kept separately from
  // `current` because a fix that matches nothing ends the run but does not tell
  // us the rider teleported -- the next fix should still be held to a route out
  // of here.
  let anchorSegmentId: number | null = null;
  let anchorAtMs = 0;

  for (const sample of samples) {
    if (sample.headingDeg == null || sample.headingDeg < 0) continue;
    if (sample.accuracyM != null && sample.accuracyM > MAX_ACCURACY_M) continue;

    const sampleAtMs = Date.parse(sample.recordedAt);
    const anchored =
      anchorSegmentId != null && (sampleAtMs - anchorAtMs) / 1000 <= ANCHOR_MAX_GAP_S;
    const reachable = anchored ? adjacency.get(anchorSegmentId!) : undefined;

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
      // With no usable anchor every candidate is treated as connected, so the
      // penalty cancels and ranking is by distance alone, as it was before.
      const connected =
        !anchored || segment.id === anchorSegmentId || (reachable?.has(segment.id) ?? false);
      candidates.push({
        segment,
        direction: hit.direction,
        distanceM: hit.distanceM,
        scoreM: hit.distanceM + (connected ? 0 : disconnectPenaltyM),
      });
    }

    if (candidates.length === 0) {
      current = null;
      continue;
    }

    let best = candidates[0];
    for (const candidate of candidates) {
      if (candidate.scoreM < best.scoreM) best = candidate;
    }

    // Stay on the run's current segment unless something is decisively
    // closer. Candidates are already filtered by bearing, so a genuine turn
    // onto another street drops the old segment from the list entirely and
    // this can't wrongly hold on to it.
    if (current) {
      const staying = candidates.find(
        (c) => c.segment.id === current!.segmentId && c.direction === current!.direction,
      );
      if (staying && staying.scoreM <= best.scoreM + SWITCH_MARGIN_M) {
        current.samples.push(sample);
        anchorSegmentId = staying.segment.id;
        anchorAtMs = sampleAtMs;
        continue;
      }
    }

    current = { segmentId: best.segment.id, direction: best.direction, samples: [sample] };
    runs.push(current);
    anchorSegmentId = best.segment.id;
    anchorAtMs = sampleAtMs;
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
