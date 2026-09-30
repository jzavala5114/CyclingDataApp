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

// The floor under the pooling rule.
//
// Frontage is summed over every nearby road, which is deliberate -- #23278 is
// 30m of Transit Drive's pavement and 102m of Hancock's, and its best single
// ROAD holds only 53%, so a single-road gate would reject the segment this
// whole rewrite exists to fold. But summed over "every nearby road" with no
// floor, the rule is unbounded: 25 mutually disjoint roads each flanking a
// twenty-fifth of a path score frontage 1.000 with no road holding 7%, and
// #19091 really does fold on 24% from its best road across six of them.
//
// So require one of two things, either of which makes "runs alongside streets"
// true rather than arithmetic:
//
//   - the roads that won steps form ONE connected run of street network (a
//     pavement round a corner, which is the case pooling exists for), or
//   - one street holds at least this much of the path (a pavement along one
//     street whose pieces the splitter happened to cut up).
//
// Grouping by street NAME rather than by road id is what makes the second test
// work: Hancock's #17973 and #17974 are two rows and one street, so #23278
// scores 0.697 by street against 0.531 by road.
//
// Measured over the 745 folds, the pair costs exactly ONE: #89600, 129m, split
// 30.9% / 30.5% between University Park Boulevard and an unnamed road that do
// not meet. That is the case this file previously documented as the honest
// counterexample and then folded anyway. Every stricter guard measured cost
// more and bought nothing: best road >= 0.35 lost 16, connectivity alone lost
// 20, best street >= 0.50 lost 90.
export const MIN_BEST_STREET_FRONTAGE = 0.4;

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
 * What a path may be folded INTO. A path never folds into another path.
 *
 * This is the shipped rule and it is deliberately narrow: only roads parent.
 * `TRAIL_PARENTS_SQL` below is the wider alternative, which was built,
 * measured against the live network and the full matcher, and rejected.
 */
export const parentSql = () => `r.kind = 'road'`;

/**
 * The rejected alternative: any segment that is not itself foldable, which
 * admits named trails as parents alongside roads.
 *
 * Written as the complement of `eligibleSql` rather than as its own list, so
 * the two sets are disjoint by construction and a chain -- path A hidden
 * behind path B which is itself hidden behind road C -- cannot be expressed.
 * Nothing downstream would notice such a chain, because all five readers of
 * `canonical_segment_id` test it for null and none reads its value.
 *
 * **Measured 2026-09-30 and rejected.** It finds 195 real duplicates -- unnamed
 * footways at frontage 1.000 running the full length of Pikes Peak Greenway,
 * Templeton Gap Trail and 163 others, which are the walking half of a shared
 * path mapped twice. 0 folds lost, 0 reparents. But replayed through the real
 * matcher over all 42 usable rides, every measure moved the wrong way:
 *
 *   arm          impossible   merged  discard  buckets  covered_km  lines
 *   roads only   26/367 7.1%    2228    18.4%    14710      225.10    749
 *   trails too   29/366 7.9%    2223    18.7%    14701      224.91    745
 *
 * Four lines lost, none gained. Hiding a path did not move its fixes onto the
 * parent trail; it lost them. And impossible transitions ROSE, which is the
 * measure this whole linker exists to reduce.
 *
 * The honest caveat, from the eval's own blind spot: 191 of the 195 folds
 * (97.9%) are on paths nobody has ridden, so the replay is blind to them. The
 * case is not closed, it is unproven and currently costing four lines. Re-run
 * it when those trails have been ridden:
 *
 *   buildLinkPlan(client, { parentClause: TRAIL_PARENTS_SQL() })
 */
export const TRAIL_PARENTS_SQL = () => `not (${eligibleSql("r")})`;

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
export const candidateSql = (parentClause = parentSql()) => `
  select f.id,
         f.kind,
         f.is_sidewalk,
         f.street_name,
         f.length_m,
         f.canonical_segment_id,
         ST_AsGeoJSON(f.geom) as path_gj,
         coalesce(
           json_agg(json_build_object(
             'id', r.id, 'gj', ST_AsGeoJSON(r.geom),
             'name', r.street_name, 'a', r.start_node_id, 'b', r.end_node_id))
             filter (where r.id is not null),
           '[]'
         ) as roads
    from segments f
    left join segments r
      on ${parentClause}
     and r.geom && ST_Expand(f.geom, $2)
     and ST_DWithin(f.geom::geography, r.geom::geography, $3)
   where ${eligibleSql("f")}
     and f.id > $1
   group by f.id
   order by f.id
   limit $4`;

/** The query as it is actually run. Pinned character for character by a test. */
export const CANDIDATE_SQL = candidateSql();

/**
 * Computes a frontage measurement for every eligible path.
 *
 * Returns one record per path, with the frontage and the best parent already
 * worked out but NO threshold applied -- `minFrontage` is a filter over the
 * result, so a sweep can try several without re-reading the database.
 */
/**
 * One page of the candidate query, text and bound values together.
 *
 * The values are here rather than at the call site because their ORDER is
 * load-bearing and invisible: `$2` feeds ST_Expand on a 4326 geometry, so it is
 * DEGREES, and `$3` feeds ST_DWithin on geography, so it is METRES. Swapping
 * them is a one-character edit that leaves every path with no candidate roads,
 * every frontage at 0 and nothing folded, and no assertion about the constants
 * themselves can see it.
 */
export function candidateQuery(after, batch = BATCH, { parentClause } = {}) {
  return {
    text: parentClause ? candidateSql(parentClause) : CANDIDATE_SQL,
    values: [after, PREFILTER_DEG, MAX_OFFSET_M, batch],
  };
}

export async function buildLinkPlan(client, { onProgress, batchSize = BATCH, parentClause } = {}) {
  const plan = [];
  let after = -1;

  for (;;) {
    const { text, values } = candidateQuery(after, batchSize, { parentClause });
    const { rows } = await client.query(text, values);
    if (rows.length === 0) break;
    // The LAST row of the page, because the query orders ascending by id. Taking
    // the first would re-read the page forever.
    after = Number(rows[rows.length - 1].id);

    for (const row of rows) {
      const path = JSON.parse(row.path_gj).coordinates;
      const roads = row.roads.map((r) => ({ id: Number(r.id), coords: JSON.parse(r.gj).coordinates }));
      const m = measureFrontage(path, roads);
      // Node ids are bigints, so pg hands them back as strings. Normalise, or
      // the connectivity test compares a string to a number and finds nothing
      // connected -- which fails closed, and so would have been invisible.
      const meta = new Map(
        row.roads.map((r) => [Number(r.id), { name: r.name, a: String(r.a), b: String(r.b) }]),
      );
      const shape = poolShape(m.byRoad, m.lengthM, meta);
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
        pooledConnected: shape.connected,
        bestStreetFrontage: shape.bestStreetFrontage,
        streetsPooled: shape.streets,
      });
    }

    onProgress?.(plan.length, after);
    if (rows.length < batchSize) break;
  }

  return plan;
}

/**
 * Applies a threshold to a plan and classifies every path against the parent it
 * currently has. `null` means "stays canonical".
 */
export function decide(plan, minFrontage) {
  return plan.map((p) => {
    // Frontage says how much of the path runs alongside SOMETHING. The shape
    // test says that something is one run of street network, or one street.
    // Both, or the path stays canonical. See MIN_BEST_STREET_FRONTAGE.
    const shapeOk =
      p.pooledConnected === true || (p.bestStreetFrontage ?? 0) >= MIN_BEST_STREET_FRONTAGE;
    const newParent = p.frontage >= minFrontage && shapeOk ? p.parentId : null;
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

/**
 * Describes the SHAPE of a path's pooled frontage: is it one connected run of
 * street network, and how much of it does its biggest single street hold?
 *
 * `byRoad` is measureFrontage's per-road credit in metres. `meta` maps a road
 * id to `{ name, a, b }` (street name and the two OSM end nodes).
 *
 * Connectivity is one component, not any-pair-touching. Union-find over the
 * roads that actually won steps: three roads where two touch and the third
 * floats are NOT a connected run, and treating them as one is how a path near
 * several unrelated streets would slip through.
 */
export function poolShape(byRoad, lengthM, meta) {
  const ids = [...byRoad.keys()];
  const byStreet = new Map();
  for (const [id, metres] of byRoad) {
    // An unnamed road is its own street. Two unnamed roads are NOT the same
    // street just because both are nameless, which grouping on null would say.
    const key = meta.get(id)?.name ?? `#${id}`;
    byStreet.set(key, (byStreet.get(key) ?? 0) + metres);
  }
  const bestStreetM = byStreet.size === 0 ? 0 : Math.max(...byStreet.values());

  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (x, y) => parent.set(find(x), find(y));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = meta.get(ids[i]);
      const b = meta.get(ids[j]);
      if (!a || !b) continue;
      if (a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b) union(ids[i], ids[j]);
    }
  }
  const components = new Set(ids.map(find)).size;

  return {
    // One road, or none, is trivially one run.
    connected: ids.length < 2 || components === 1,
    bestStreetFrontage: lengthM > 0 ? bestStreetM / lengthM : 0,
    streets: byStreet.size,
  };
}

/**
 * The three flags, off unless asked for.
 *
 * Here rather than inline in the script so the defaults are a tested fact
 * rather than three `includes` calls nothing checks. `apply` off means a run
 * with no arguments cannot write; `unfold` off means it cannot release the 743
 * paths whose release costs Brenner Place its line; `reparent` off means it
 * cannot turn a 745-row write into a 6,307-row one.
 */
export function parseFlags(argv = []) {
  return {
    apply: argv.includes("--apply"),
    unfold: argv.includes("--unfold"),
    reparent: argv.includes("--reparent"),
  };
}

/**
 * Everything one run of the linker decides, from a measured plan.
 *
 * `link_canonical.mjs` used to do this inline, which meant the threshold was
 * passed at a call site (`decide(plan, MIN_FRONTAGE)` -> `decide(plan, 0.95)`
 * restores the Hancock hole) and the write loop was a hand-copied duplicate of
 * updateBatch that no test could reach. The script now decides nothing: it
 * connects, calls this, prints it, and writes what it is given.
 *
 * Note it takes NO threshold. MIN_FRONTAGE is applied here and nowhere else.
 */
export function planRun(plan, { unfold = false, reparent = false } = {}) {
  const decided = decide(plan, MIN_FRONTAGE);
  const writes = writesFor(decided, { unfold, reparent });
  const folds = writes.filter((w) => w.action === "fold");
  const namedFolds = folds.filter((f) => f.streetName !== null);
  return {
    decided,
    counts: tally(decided),
    writes,
    folds,
    releases: writes.filter((w) => w.action === "release"),
    reparents: writes.filter((w) => w.action === "reparent"),
    namedFolds,
    // Named paths whose name does not itself say "sidewalk". Unreachable while
    // eligibility is name-based on the same predicate, so this is a tripwire on
    // the ELIGIBILITY rule -- the thing that protects Shooks Run, Midland and
    // the Pikes Peak Greenway -- not on the geometry. The caller throws.
    unintended: namedFolds.filter((f) => !/sidewalk/i.test(f.streetName)),
    // Folds where no single road holds even a third of the path. Frontage pools
    // across every nearby road, and for a corner pavement that is right; for
    // these it is the weakest the argument gets, so they are listed in full.
    thin: folds.filter((f) => f.parentFrontage < 0.35).sort((a, b) => a.parentFrontage - b.parentFrontage),
  };
}

/**
 * Writes a plan's rows, in batches, inside whatever transaction the caller has
 * opened. Throws rather than returning short: a half-applied fold is worse than
 * none, and the caller's rollback is the point.
 */
export async function applyWrites(client, writes, { batchSize = BATCH, onProgress } = {}) {
  let written = 0;
  for (let i = 0; i < writes.length; i += batchSize) {
    const { sql, values } = updateBatch(writes.slice(i, i + batchSize));
    const { rowCount } = await client.query(sql, values);
    written += rowCount;
    onProgress?.(written, writes.length);
  }
  // Before the caller commits, not after. A shortfall means a segment vanished
  // between the read and the write.
  if (written !== writes.length) {
    throw new Error(`planned ${writes.length} rows but the UPDATE matched ${written}`);
  }
  return written;
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
