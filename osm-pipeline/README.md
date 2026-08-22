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
DATABASE_URL=postgres://... npm run link
```

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
