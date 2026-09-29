# osm-pipeline

Turns a slice of OpenStreetMap into rows in the `segments` table (see
`../backend/src/db/schema.sql`) — the "what road am I on" dataset. Pulls
data straight from the public Overpass API by bounding box, so there's
nothing to install or download by hand for a small prototype area.

Currently loaded: 38.73/-104.91 to 38.96/-104.75 — central Colorado Springs
plus the northwest suburbs and Ute Valley Park. 27,775 rideable ways →
66,424 segments (30,233 road, 32,618 footway, 3,573 cycleway), of which
46,758 are canonical and the rest are sidewalks folded into a parent road.

## Steps

All five, in this order. The order is not cosmetic — see below.

```
npm install

# 1. Fetch raw ways in a bounding box from Overpass.
#    Args are minLat minLon maxLat maxLon; omit them for the default box.
node scripts/fetch_overpass.mjs 38.73 -104.91 38.96 -104.75

# 2. Classify, drop unrideable ways, split at intersections, cap at 150 m
npm run split

# 3. Upsert segments.geojson into PostGIS
DATABASE_URL=postgres://... npm run load

# 4. Delete segments the current extract no longer produces
DATABASE_URL=postgres://... npm run prune          # shows what would go
DATABASE_URL=postgres://... npm run prune -- --apply

# 5. Point each sidewalk at the road it runs alongside
DATABASE_URL=postgres://... npm run link           # shows what would change
DATABASE_URL=postgres://... npm run link -- --apply
```

`link` is a dry run unless `--apply` is passed, and either way it writes the
full per-line diff to a CSV under your temp directory and prints the path.
`--apply` also writes a snapshot of every row's previous parent next to it, so
the change can be reversed.

Then rebuild the elevation model, since segment ids and boundaries may have
moved underneath it:

```
cd ../backend && npm run rebuild-model
```

## Why the order matters

**`prune` after `load`.** `load` upserts on
`(osm_way_id, start_node_id, end_node_id, piece_index)`, so it can only add or
update — it has no way to know a row it wrote last time is now obsolete. That
bites whenever the bbox grows: a segment boundary is "a node shared by two or
more kept ways", so a newly imported way touching an existing one turns that
node into an intersection and re-splits the old way. The new pieces arrive
under new keys and the old piece stays behind, leaving two overlapping
geometries for the same tarmac for the matcher to argue over. Growing the box
to include Ute Valley orphaned 609 segments this way.

**`prune` before `link`.** Deleting a road sets its sidewalks'
`canonical_segment_id` back to null (`on delete set null`), which would promote
them to standalone routes drawing their own gradient lines. Linking last
re-points whatever survives.

## How linking decides

Eligibility is **by name**: a path qualifies if OSM tags it `footway=sidewalk`,
or if nobody named it at all. Proximity alone is not enough — an early purely
geometric pass absorbed the stretches where a real trail runs beside a road and
cut Shooks Run (−57 segments), Midland (−35) and the Pikes Peak Greenway (−10)
into disconnected pieces. Every trail it ate was named, so the name test is what
protects them, and `link` reports any named line it is about to fold on every
run.

Among eligible paths, "runs alongside" is decided by **frontage**: the path is
walked in 5 m steps and each step asks whether a road is within 20 m and heading
the same way *at that point*. Fold at 60%. The previous rule compared
`bearing_deg` — the straight line from a segment's first point to its last —
which is meaningless on anything that bends: one 146 m footway beside Hancock
Expressway runs 30 m east along Transit Drive, turns through a 14 m corner and
then runs 102 m south along Hancock, and its chord missed Hancock's by 20.6°, so
it stayed canonical, competed with Hancock for GPS fixes and left Hancock
`#17973` with 0 m of its 91 m drawn.

Frontage is measured against **all** nearby roads together, not one at a time,
because roads are split at junctions and capped at 150 m while paths are split
on their own nodes — a 146 m path routinely straddles two 91 m pieces of one
street and would score 50% against each. The parent is then whichever single
road holds the largest share.

Pooling that way is unbounded on its own, so there is a floor: the roads that
won steps must form **one connected run** of street network, or **one street**
must hold 40% of the path. Grouping by street name is what makes the second
test work, since two pieces of Hancock are two rows and one street. The floor
costs one fold in 745 and the dry run lists the thinnest survivors in full.

`link` only ever **adds** parents. `canonical_segment_id` is a "hide me" flag —
every reader tests it for null and none reads which road it names — so a fold
is the only kind of write that moves a line on the map. Releasing a path can
regress a road (recomputing from scratch cost Brenner Place its line), and
re-pointing an already-folded path at a better road changes nothing observable.
Both are therefore opt-in, `--unfold` and `--reparent`, and the dry run reports
what each would do.

To measure the effect before writing, run `npm run eval:linker` in `../backend`:
it replays the real matcher over every usable session with both candidate sets
and prints a per-line gained/lost diff. The geometry itself is unit tested
without a database in `scripts/lib/frontage.test.mjs` (`npm test`).

## How splitting works

`scripts/split_ways.mjs` treats any node shared by more than one way as an
intersection, and cuts each way into a new segment every time it passes
through one — so a segment always spans exactly one block, from one cross
street to the next. Each segment keeps its OSM way id, street name, the OSM
node ids at each end, its length, and its compass bearing (the "forward"
direction — see `backend/src/db/schema.sql` for how `forward`/`backward`
are defined relative to it).

This is a heuristic, not a full router-grade road model: it keeps anything
tagged `highway=*` except a small exclusion list (motorways, construction,
steps). Good enough to get real segments on the map for a prototype;
revisit if you need proper cycling-suitability filtering later.
