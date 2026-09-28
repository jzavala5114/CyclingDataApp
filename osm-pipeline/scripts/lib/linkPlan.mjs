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
// without a database. In JS it is `scripts/lib/frontage.mjs`, which needs no
// connection string. Run `npm test` for the count rather than trusting a number
// written in a comment; the one that used to be here was stale within a day.

import { measureFrontage, MAX_OFFSET_M } from "./frontage.mjs";

// Fold a path when at least this much of its length runs alongside a road.
//
// Exported and tested HERE rather than left in link_canonical.mjs, which is
// where it started. As a module-private constant in the script it was the one
// number that decides whether a line disappears off the map and the only part
// of the rule no test could see: raising it to 0.95 restores the Hancock hole
// and leaves the whole suite green. A threshold that cannot be tested is a
// threshold that is not tested.
//
// The value is not delicate and that was measured, not assumed: 0.5, 0.6 and
// 0.7 give identical buckets, coverage and impossible-transition rates through
// the full matcher, because the populations are bimodal -- 78% of the paths the
// old chord rule folded score exactly 1.0, 91% of the ones it left canonical
// score below 0.1, and the middle is nearly empty.
export const MIN_FRONTAGE = 0.6;

// Cheap bounding-box prefilter the GiST index can serve. Casting straight to
// geography for every candidate pair instead makes the planner scan the whole
// table and blows the statement timeout. It MUST exceed MAX_OFFSET_M or the
// prefilter silently becomes the filter; `prefilterCoversOffset` below is the
// assertion, and a test holds it.
export const PREFILTER_DEG = 0.0004; // ~35m at this latitude, comfortably over MAX_OFFSET_M

/** Metres the bbox prefilter reaches at this latitude. Must exceed MAX_OFFSET_M. */
export const prefilterReachM = (lat = 38.82) =>
  PREFILTER_DEG * 111320 * Math.cos((lat * Math.PI) / 180);

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
 * The candidate query, as a string so a test can hold it to its promises.
 *
 * Four clauses in here decide correctness and none of them is reachable from a
 * database-free test: `r.kind = 'road'` (a path must not fold into another
 * path), `ST_DWithin` (without it the bbox prefilter becomes the whole test),
 * the eligibility clause, and keyset pagination that reads each row once.
 * Asserting on the text is weaker than exercising it, and it is what is
 * available; the alternative is four silent mutations, which is what was here.
 *
 * Paged by keyset (`f.id > $1 order by f.id limit`) rather than by id range.
 * `segments.id` is a bigserial that grows on every reload while the row count
 * does not: the live table holds 31,910 eligible paths spread over ids 5,852 to
 * 158,309, so striding the id space in fixed steps issued 305 queries averaging
 * 105 rows, and the next import would make that worse for free.
 */
export const CANDIDATE_SQL = `
  select f.id,
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
     and r.geom && ST_Expand(f.geom, $2)
     and ST_DWithin(f.geom::geography, r.geom::geography, $3)
   where ${eligibleSql("f")}
     and f.id > $1
   group by f.id
   order by f.id
   limit $4`;

/**
 * Computes a frontage measurement for every eligible path.
 *
 * Returns one record per path, with the frontage and the best parent already
 * worked out but NO threshold applied -- `minFrontage` is a filter over the
 * result, so a sweep can try several without re-reading the database.
 */
export async function buildLinkPlan(client, { onProgress } = {}) {
  const plan = [];
  let after = -1;

  for (;;) {
    const { rows } = await client.query(CANDIDATE_SQL, [after, PREFILTER_DEG, MAX_OFFSET_M, BATCH]);
    if (rows.length === 0) break;
    after = Number(rows[rows.length - 1].id);

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

    onProgress?.(plan.length, after);
    if (rows.length < BATCH) break;
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

/**
 * The parent a run would actually WRITE for one decided path, given the policy
 * flags. Returning `d.currentParent` means "leave this row alone".
 *
 * This lives here, not in link_canonical.mjs, because it is the last step
 * between a measurement and a row in the database and it was previously a
 * closure inside the script where nothing could test it. Every one of these
 * survived the suite while it lived there: --unfold on by default, returning
 * `d.id` so a path becomes its own parent, and swapping the id and the parent
 * in the UPDATE's value list.
 *
 * Both flags default off. Releasing a path is the half that can regress a road
 * -- recomputing every parent from scratch releases 743 and costs Brenner Place
 * #37523 and #8361 their lines. Re-pointing an already-folded path at a better
 * road is inert, because every reader of canonical_segment_id tests it for null
 * and none reads its value, so it would enlarge the write eightfold and move
 * nothing.
 */
export function plannedParent(d, { unfold = false, reparent = false } = {}) {
  if (d.currentParent === null) return d.newParent; // fold, or stay canonical
  if (d.newParent === null) return unfold ? null : d.currentParent; // release
  return reparent ? d.newParent : d.currentParent;
}

/**
 * Builds one batched UPDATE from a slice of `writesFor`'s output.
 *
 * Here rather than inline in the script for the same reason as plannedParent:
 * it is the statement that changes the database and nothing could see it.
 * Swapping the two pushed values -- keying the update on the PARENT and setting
 * the id -- survived the whole suite, and would repoint arbitrary roads at
 * arbitrary segments.
 *
 * A VALUES join rather than one UPDATE per row: 745 round trips against a
 * hosted database is a different proposition from one. The ::bigint casts are
 * load-bearing, because an all-NULL column in a VALUES list is otherwise typed
 * `text` and the join fails.
 */
export function updateBatch(batch) {
  const values = [];
  const tuples = batch.map((d, j) => {
    values.push(d.id, d.writeParent);
    return `($${j * 2 + 1}::bigint, $${j * 2 + 2}::bigint)`;
  });
  return {
    sql: `update segments s set canonical_segment_id = v.parent
            from (values ${tuples.join(", ")}) as v(id, parent)
           where s.id = v.id`,
    values,
  };
}

/** The rows a run would write, and what each one is. */
export function writesFor(decided, opts = {}) {
  return decided
    .map((d) => ({ ...d, writeParent: plannedParent(d, opts) }))
    .filter((d) => d.writeParent !== d.currentParent)
    .map((d) => ({
      ...d,
      action: d.currentParent === null ? "fold" : d.writeParent === null ? "release" : "reparent",
    }));
}
