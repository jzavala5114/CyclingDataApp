// Works out, for every path the linker is allowed to touch, which road it
// should be folded into -- without writing anything.
//
// Split out from link_canonical.mjs so that the sweep that picks MIN_FRONTAGE,
// the dry run that reports what would change, and the run that actually writes
// all share one implementation. A threshold chosen by one code path and applied
// by another is the kind of gap this project has been bitten by before.
//
// Postgres does the search and JS does the decision, deliberately. The GiST
// index on `geom` is what makes "roads within 35m of this path" cheap, and
// nothing replaces it. But "is this path pointing the way the road points, at
// this point along it" needs a local tangent, which in PostGIS means
// ST_LineLocatePoint/ST_LineSubstring gymnastics that cannot be unit tested
// without a database. In JS it is `scripts/lib/frontage.mjs`, which has 31
// free tests and no connection string.

import { measureFrontage, MAX_OFFSET_M } from "./frontage.mjs";

// Cheap bounding-box prefilter the GiST index can serve. Casting straight to
// geography for every candidate pair instead makes the planner scan the whole
// table and blows the statement timeout.
export const PREFILTER_DEG = 0.0004; // ~35m at this latitude, comfortably over MAX_OFFSET_M
const BATCH = 500;

// Which paths the linker may fold. Unchanged by this rewrite, and deliberately
// so: eligibility is by NAME and the geometry test is what is being replaced.
// A path qualifies if OSM tags it footway=sidewalk, or if nobody named it --
// of the paths here running within 20m of a road and parallel to it, most are
// unnamed, and a path that hugs a street for its whole length without earning a
// name is a pavement whatever its tags say. Every trail lost to the original
// geometric pass (Shooks Run -57, Midland -35, Pikes Peak Greenway -10) was
// named, so the name test alone is what protects them.
// Takes the table alias, because every column has to be qualified: prefixing
// the whole clause with `f.` only reaches its first token, which silently made
// `street_name` ambiguous against the joined roads.
export const eligibleSql = (a) => `${a}.kind in ('footway','cycleway')
   and (${a}.street_name is null or ${a}.street_name ilike '%sidewalk%')`;

/**
 * Computes a frontage measurement for every eligible path.
 *
 * Returns one record per path, with the frontage and the best parent already
 * worked out but NO threshold applied -- `minFrontage` is a filter over the
 * result, so a sweep can try several without re-reading the database.
 */
export async function buildLinkPlan(client, { onProgress } = {}) {
  const { rows: bounds } = await client.query(
    `select min(s.id) as lo, max(s.id) as hi from segments s where ${eligibleSql("s")}`,
  );
  if (bounds[0].lo === null) return [];
  const lo = Number(bounds[0].lo);
  const hi = Number(bounds[0].hi);

  const plan = [];
  let scanned = 0;

  for (let start = lo; start <= hi; start += BATCH) {
    const { rows } = await client.query(
      `select f.id,
              f.kind,
              f.is_sidewalk,
              f.street_name,
              f.length_m,
              f.canonical_segment_id,
              ST_AsGeoJSON(f.geom) as path_gj,
              coalesce(
                json_agg(json_build_object('id', r.id, 'gj', ST_AsGeoJSON(r.geom)))
                  filter (where r.id is not null),
                '[]'
              ) as roads
         from segments f
         left join segments r
           on r.kind = 'road'
          and r.geom && ST_Expand(f.geom, $3)
          and ST_DWithin(f.geom::geography, r.geom::geography, $4)
        where ${eligibleSql("f")}
          and f.id >= $1 and f.id < $2
        group by f.id`,
      [start, start + BATCH, PREFILTER_DEG, MAX_OFFSET_M],
    );

    for (const row of rows) {
      const path = JSON.parse(row.path_gj).coordinates;
      const roads = row.roads.map((r) => ({ id: Number(r.id), coords: JSON.parse(r.gj).coordinates }));
      const m = measureFrontage(path, roads);
      plan.push({
        id: Number(row.id),
        kind: row.kind,
        isSidewalk: row.is_sidewalk,
        streetName: row.street_name,
        lengthM: Number(row.length_m),
        currentParent: row.canonical_segment_id === null ? null : Number(row.canonical_segment_id),
        frontage: m.frontage,
        parentId: m.parentId,
        parentFrontage: m.parentFrontage,
        roadsNearby: roads.length,
      });
    }

    scanned += rows.length;
    onProgress?.(scanned, Math.min(start + BATCH, hi + 1), hi);
  }

  return plan;
}

/**
 * Applies a threshold to a plan and classifies every path against the parent it
 * currently has. `null` means "stays canonical".
 */
export function decide(plan, minFrontage) {
  return plan.map((p) => {
    const newParent = p.frontage >= minFrontage ? p.parentId : null;
    let change = "unchanged";
    if (p.currentParent === null && newParent !== null) change = "fold";
    else if (p.currentParent !== null && newParent === null) change = "unfold";
    else if (p.currentParent !== newParent) change = "reparent";
    return { ...p, newParent, change };
  });
}

export function tally(decided) {
  const t = { total: decided.length, fold: 0, unfold: 0, reparent: 0, unchanged: 0 };
  for (const d of decided) t[d.change]++;
  return t;
}
