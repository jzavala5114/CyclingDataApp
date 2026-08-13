# osm-pipeline

Turns a slice of OpenStreetMap into rows in the `segments` table (see
`../backend/src/db/schema.sql`) — the "what road am I on" dataset. Pulls
data straight from the public Overpass API by bounding box, so there's
nothing to install or download by hand for a small prototype area.

Already run once for the neighborhood in the reference photo — 311 E
Cimarron St, Colorado Springs, 80903 — the checked-in `data/extract.json`
and `data/segments.geojson` cover Cascade Ave to Wahsatch Ave, Vermijo Ave
to Rio Grande St (1,122 ways → 2,791 intersection-to-intersection segments,
including 36 covering both directions of E/W Cimarron St itself).

## Steps

```
npm install

# 1. Fetch raw roads in a bounding box from Overpass (defaults to the
#    Cimarron St neighborhood above; pass minLat minLon maxLat maxLon for
#    a different area)
npm run fetch

# 2. Split every way into segments at intersection nodes
npm run split

# 3. Load segments.geojson into PostGIS
DATABASE_URL=postgres://... npm run load
```

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
