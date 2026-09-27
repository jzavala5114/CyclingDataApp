// Does this path run alongside a road, and if so which one?
//
// The question link_canonical.mjs has to answer is "is this a pavement or a
// route in its own right". It used to answer it by comparing `bearing_deg` --
// the straight line from a segment's first point to its last -- against the
// road's, within 20 degrees. That is the chord, and this project has already
// proved the chord meaningless on anything that bends: the same mistake in the
// matcher was fixed by switching to per-edge tangents (see note 17 in
// context/session.md).
//
// The concrete failure. Segment #23278 is one 146m footway piece beside
// Hancock Expressway, and it turns a corner: 41m running east along the cross
// street, then 102m running south along Hancock. Its chord bearing is 161.8
// degrees, Hancock's is 182.4, so the test sees a 20.6 degree miss and leaves
// the path canonical -- where it then competes with Hancock for a rider's GPS
// fixes and punches a 191m hole in a road that was ridden end to end. Nothing
// about that piece is 20 degrees off Hancock. 70% of it is exactly parallel and
// the other 30% belongs to a different street; the chord is the average of two
// legs that have no business being averaged.
//
// So measure frontage instead of bearing. Walk the path in short steps and ask
// of each step: am I within MAX_OFFSET_M of a road, and is the road heading the
// same way I am *here*? The fraction of the path's length that answers yes is
// its frontage. A pavement scores near 1 however many corners it turns. A
// connector crossing between two streets scores near 0 even though both of its
// ends are close to tarmac, because at no point is it pointing the way the road
// points.
//
// Frontage is measured against the road network as a whole, not against one
// road, because roads are split at junctions and capped at 150m while paths are
// split on their own nodes -- a 146m path routinely straddles two 91m pieces of
// the same street and would score 50% against each. The parent is then whichever
// single road contributed the most of that frontage.

// A sidewalk within this distance of a road is a sidewalk *of* that road. 20m
// covers a verge plus a parking lane plus half a carriageway.
export const MAX_OFFSET_M = 20;
// How far a step's heading may differ from the road's local heading. Compared
// modulo 180: a path's digitised direction is arbitrary relative to the road's,
// so antiparallel is parallel.
export const MAX_TANGENT_DELTA_DEG = 20;
// Step length along the path. Short enough to resolve a corner on the shortest
// segment the splitter emits (8m), long enough that a 150m piece is ~30 steps.
export const STEP_M = 5;

const DEG = Math.PI / 180;
// WGS84 metres per degree of latitude at this latitude. Colorado Springs sits
// at 38.8N and every comparison here spans at most 150m, so a local
// equirectangular plane is exact to well under a centimetre -- far below the
// 20m and 20 degree thresholds it feeds.
const M_PER_DEG_LAT = 111132.0;
const M_PER_DEG_LON_AT = (lat) => 111320.0 * Math.cos(lat * DEG);

/**
 * Projects [lon, lat] pairs onto a local metre plane centred on `lat0`/`lon0`.
 * Returns a flat [x0, y0, x1, y1, ...] array: flat because this runs millions
 * of times and the allocation of a pair-of-pairs per point dominated it.
 */
export function toLocalMetres(lngLat, lat0, lon0) {
  const mx = M_PER_DEG_LON_AT(lat0);
  const out = new Float64Array(lngLat.length * 2);
  for (let i = 0; i < lngLat.length; i++) {
    out[i * 2] = (lngLat[i][0] - lon0) * mx;
    out[i * 2 + 1] = (lngLat[i][1] - lat0) * M_PER_DEG_LAT;
  }
  return out;
}

/** True when every ordinate is a real number. */
function allFinite(flat) {
  for (let i = 0; i < flat.length; i++) if (!Number.isFinite(flat[i])) return false;
  return true;
}

/** Heading of the vector a->b in degrees, folded onto [0, 180). */
export function headingDeg(ax, ay, bx, by) {
  let d = Math.atan2(by - ay, bx - ax) / DEG;
  d %= 180;
  if (d < 0) d += 180;
  return d;
}

/** Smallest angle between two undirected headings, in [0, 90]. */
export function headingDelta(a, b) {
  const d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

/**
 * Nearest point on a polyline to (px, py).
 *
 * Returns the distance in metres and the index of the leg it landed on, which
 * is what gives us the road's *local* tangent rather than its chord. Returns
 * `legIndex: -1` for a polyline with no usable leg.
 */
export function projectToPolyline(px, py, flat) {
  let bestSq = Infinity;
  let legIndex = -1;
  const legs = flat.length / 2 - 1;
  for (let i = 0; i < legs; i++) {
    const ax = flat[i * 2];
    const ay = flat[i * 2 + 1];
    const vx = flat[i * 2 + 2] - ax;
    const vy = flat[i * 2 + 3] - ay;
    const lenSq = vx * vx + vy * vy;
    let t = 0;
    if (lenSq > 0) {
      t = ((px - ax) * vx + (py - ay) * vy) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const dx = px - (ax + t * vx);
    const dy = py - (ay + t * vy);
    const sq = dx * dx + dy * dy;
    // Strictly-less keeps the FIRST leg on an exact tie, which matters only for
    // a point equidistant from two legs meeting at a vertex; either tangent is
    // as defensible as the other, so the tie is broken deterministically rather
    // than correctly.
    if (sq < bestSq) {
      bestSq = sq;
      legIndex = i;
    }
  }
  return { distM: Math.sqrt(bestSq), legIndex };
}

/**
 * Splits a path into ~STEP_M steps and returns one sample per step: its
 * midpoint, its length, and the heading of the leg it came from.
 *
 * Sampling by midpoint rather than by vertex is what makes the fraction a
 * fraction of LENGTH. Counting vertices would weight a 3m kink at an
 * intersection the same as a 140m straight, and OSM puts its vertices where the
 * geometry bends, which is exactly where a pavement stops looking parallel.
 */
export function sampleSteps(flat, stepM = STEP_M) {
  const samples = [];
  const legs = flat.length / 2 - 1;
  for (let i = 0; i < legs; i++) {
    const ax = flat[i * 2];
    const ay = flat[i * 2 + 1];
    const bx = flat[i * 2 + 2];
    const by = flat[i * 2 + 3];
    const dx = bx - ax;
    const dy = by - ay;
    const legLen = Math.hypot(dx, dy);
    // A repeated vertex has no heading. Skipping it is right rather than
    // convenient: it contributes no length, so it cannot change a fraction.
    if (legLen === 0) continue;
    const heading = headingDeg(ax, ay, bx, by);
    const n = Math.max(1, Math.ceil(legLen / stepM));
    const each = legLen / n;
    for (let s = 0; s < n; s++) {
      const t = (s + 0.5) / n;
      samples.push({ x: ax + dx * t, y: ay + dy * t, lengthM: each, heading });
    }
  }
  return samples;
}

/**
 * How much of `path` runs alongside `roads`, and which road owns most of it.
 *
 * `path` is [[lon, lat], ...]. `roads` is [{ id, coords }].
 *
 * Returns { frontage, lengthM, parentId, parentFrontage, byRoad }, where
 * `frontage` is the fraction of the path's length running alongside ANY of the
 * roads and `parentId` is the road holding the largest share of it. `frontage`
 * is 0 and `parentId` null when nothing qualifies.
 */
export function measureFrontage(path, roads, opts = {}) {
  const maxOffsetM = opts.maxOffsetM ?? MAX_OFFSET_M;
  const maxDeltaDeg = opts.maxTangentDeltaDeg ?? MAX_TANGENT_DELTA_DEG;
  const stepM = opts.stepM ?? STEP_M;

  const empty = { frontage: 0, lengthM: 0, parentId: null, parentFrontage: 0, byRoad: new Map() };
  // An empty path has no path[0] to centre the projection on. A path with one
  // point does, and falls out at the no-samples check below; no separate guard
  // for it. There is deliberately no "no roads" guard either -- that case exits
  // at `prepared.length === 0`, which reports the path's real length instead of
  // zero.
  if (!path || path.length < 2) return empty;

  const lat0 = path[0][1];
  const lon0 = path[0][0];
  const pathFlat = toLocalMetres(path, lat0, lon0);
  // A single non-finite ordinate does not make this function throw or return
  // NaN -- it makes it LIE, in the unsafe direction. sampleSteps drops the
  // offending leg (Math.max(1, Math.ceil(NaN/5)) is NaN, and `s < NaN` is false
  // at once), so the leg leaves both the numerator and the denominator. A path
  // measured at 0.21 frontage, which would stay canonical, comes back at
  // exactly 1.0 and folds, because the only part that disagreed with the road
  // was the part that vanished. That is the same shape as the NaN defect this
  // project has already paid for twice: the threshold is not tripped, it is
  // switched off. Refuse to measure instead, which leaves the path canonical.
  if (!allFinite(pathFlat)) return empty;
  const samples = sampleSteps(pathFlat, stepM);
  if (samples.length === 0) return empty;

  const lengthM = samples.reduce((a, s) => a + s.lengthM, 0);

  const prepared = [];
  // Sorted by id so the answer cannot depend on the order the caller's query
  // happened to return rows in. Two roads are never *exactly* equidistant from
  // a sample in floating point, so this does not decide real cases -- it
  // decides the ones where the decision does not matter, and decides them the
  // same way every run.
  for (const r of [...roads].sort((a, b) => a.id - b.id)) {
    // Unreachable against the real column, which is geometry(LineString, 4326)
    // and so always carries at least two points, and no test can kill it: a
    // one-point road yields no legs, projectToPolyline returns legIndex -1, and
    // the check below drops the sample anyway. Kept because the cost is one
    // comparison and the alternative is a throw deep inside a batch job.
    if (!r.coords || r.coords.length < 2) continue;
    const flat = toLocalMetres(r.coords, lat0, lon0);
    // Same reasoning as the path. Note it is not enough that a NaN distance
    // loses every comparison: a road whose LAST point is bad still has finite
    // legs, and projectToPolyline will happily return one of them with a real
    // distance and a real heading. Such a road can win a step and become a
    // parent on the strength of the half of it that parsed. Drop the whole
    // road instead.
    if (!allFinite(flat)) continue;
    const headings = [];
    for (let i = 0; i < flat.length / 2 - 1; i++) {
      headings.push(headingDeg(flat[i * 2], flat[i * 2 + 1], flat[i * 2 + 2], flat[i * 2 + 3]));
    }
    prepared.push({ id: r.id, flat, headings });
  }
  if (prepared.length === 0) return { ...empty, lengthM };

  const byRoad = new Map();
  let alongside = 0;

  for (const s of samples) {
    // A step counts once towards the total however many roads it flanks, but
    // its length is credited to the closest road that accepts it. Crediting
    // every accepting road would let one step elect a parent it barely touches
    // -- the quorum-inflation mistake this project has been bitten by five
    // times in a different file.
    let bestId = null;
    let bestDist = Infinity;
    for (const road of prepared) {
      const { distM, legIndex } = projectToPolyline(s.x, s.y, road.flat);
      if (legIndex < 0 || distM > maxOffsetM) continue;
      if (headingDelta(s.heading, road.headings[legIndex]) > maxDeltaDeg) continue;
      if (distM < bestDist) {
        bestDist = distM;
        bestId = road.id;
      }
    }
    if (bestId === null) continue;
    alongside += s.lengthM;
    byRoad.set(bestId, (byRoad.get(bestId) ?? 0) + s.lengthM);
  }

  let parentId = null;
  let parentM = 0;
  // Ascending id breaks a tie, so two runs over the same data give the same
  // answer. Map iteration order is insertion order, which depends on which
  // sample happened to be closest first.
  for (const id of [...byRoad.keys()].sort((a, b) => a - b)) {
    const m = byRoad.get(id);
    if (m > parentM) {
      parentM = m;
      parentId = id;
    }
  }

  return {
    frontage: lengthM > 0 ? alongside / lengthM : 0,
    lengthM,
    parentId,
    parentFrontage: lengthM > 0 ? parentM / lengthM : 0,
    byRoad,
  };
}

/**
 * The linker's decision for one path: the id of the road to fold it into, or
 * null to leave it canonical.
 */
export function chooseParent(path, roads, minFrontage, opts = {}) {
  const m = measureFrontage(path, roads, opts);
  if (m.frontage < minFrontage) return null;
  return m.parentId;
}
