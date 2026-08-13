# backend

Node/TypeScript + Express API backed by PostGIS.

## Setup

```
npm install
cp .env.example .env   # point DATABASE_URL at a Postgres+PostGIS database
psql "$DATABASE_URL" -f src/db/schema.sql
npm run dev
```

## Endpoints

- `POST /sessions` — start a tracking session, returns `{ id, started_at }`
- `POST /sessions/:id/samples` — upload a batch of `{ recordedAt, lat, lon, elevationM, headingDeg, speedMps, accuracyM }`
- `POST /sessions/:id/end` — end the session; map-matches its samples to nearby segments and merges them into the running elevation model
- `GET /segments?minLon=&minLat=&maxLon=&maxLat=` — segments in a viewport, each with `directionalLines` (offset gradient geometry + color stops) ready for MapLibre

See `src/services/segmentMatcher.ts`, `elevationAggregator.ts`, and
`gradientBuilder.ts` for the core algorithms, and `src/db/schema.sql` for the
data model. `segments` must be populated first — see `../osm-pipeline`.
