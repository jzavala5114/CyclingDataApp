# CyclingDataApp

Prototype elevation tracker for cyclists. Renders **direction-dependent gradient
lines** for streets — a climb ridden eastbound and the same road ridden westbound
get two separate color-graded lines, offset to either side of the street
centerline, and each session's data refines a shared, crowdsourced elevation
model per street segment instead of overwriting it.

## Architecture

```
mobile/          Expo (React Native) app — live tracking UI + MapLibre map
backend/         Node/TypeScript API — sessions, map-matching, aggregation
osm-pipeline/    One-off scripts to import an OSM extract into PostGIS
```

```
[Expo app] --GPS + barometer samples--> [Backend API] --> [PostGIS]
     ^                                        |
     |                                        v
     +---- segment/direction gradients <-- segmentMatcher -> elevationAggregator
```

- **Road/segment data**: a small OpenStreetMap regional extract is pre-processed
  (`osm-pipeline/`) into `segments` — OSM ways split at intersection nodes —
  and loaded into PostGIS. This is the "what road am I on" dataset.
- **Elevation data**: each tracking session records raw GPS + barometric
  altitude samples (`session_samples`). This is the "what's the elevation"
  dataset. It starts out disconnected from `segments`.
- **The join**: after a session ends, `segmentMatcher` matches each sample to
  the nearest segment + travel direction (forward/backward along the way,
  determined by comparing the rider's GPS bearing to the segment's stored
  bearing). `elevationAggregator` then buckets matched samples by
  distance-along-segment and folds them into `segment_elevation_buckets` as a
  running mean — new sessions refine existing buckets, they never overwrite
  them.
- **Rendering**: `gradientBuilder` turns a segment+direction's ordered
  elevation buckets into a MapLibre `line-gradient` expression, and offsets
  the line a few meters perpendicular to the street centerline (left for one
  direction, right for the other) so both directions are visible
  simultaneously, matching the reference photo of Cimarron St.

See `backend/README.md`, `osm-pipeline/README.md`, and `mobile/README.md`
(once scaffolded) for per-area setup instructions.

## Status

Early prototype scaffold. Nothing is wired end-to-end yet — see TODOs in
`backend/src/services/*` and `osm-pipeline/scripts/*`.
