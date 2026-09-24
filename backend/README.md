# backend

Node/TypeScript + Express API backed by PostGIS.

## Setup

```
npm install
cp .env.example .env   # point DATABASE_URL at a Postgres+PostGIS database
psql "$DATABASE_URL" -f src/db/schema.sql
npm run dev
```

## Migrations

`src/db/schema.sql` is a fresh-install script — plain `create table`, so it
cannot be re-run against a database that already holds rides. Changes to an
existing database go in `src/db/migrations/`, applied in order and written to
be idempotent:

```
psql "$DATABASE_URL" -f src/db/migrations/001_elevation_source.sql
```

Keep both in step: `schema.sql` for a new database, a migration for the live one.

## Deploying

Railway, from this directory. Verify by probing `/health` for a `builtAt` that
changes with the image — during a rollout Railway reports the service healthy
and `/health` answers `ok` while the *old* container is still serving every
request, so neither is evidence that anything landed.

```
curl -s https://cyclingdataapp-backend-production.up.railway.app/health
```

Deploying is not the same as pushing. This service spent a stretch with no
GitHub connection at all, taking deploys only from `railway up --service
cyclingdataapp-backend`, which let the running server drift days behind `main`
without any signal that it had. If `git push` does not move `builtAt`, that
connection is the first thing to check.

## Tests and evals

```
npm test                # gate tests: deterministic, no database, well under 2s
npm run eval:quality    # where the elevation model stands, against the live archive
npm run eval:smoothing  # eval: the zero-phase elevation smoother
```

`npm test` runs Node's built-in test runner through tsx. It needs nothing but
the source, so it is safe on any checkout. Both evals read the live database and
write nothing.

`npm run eval:quality` reports three numbers, all asked of buckets rather than
raw samples, because the anchor correction is applied on the way into a bucket
and never written back onto the sample rows:

- **self-consistency** — one ride, one bucket, two passes at least five minutes
  apart. The ground cannot have moved, so any difference is the ride
  disagreeing with itself. Needs no second ride and no terrain model, which
  makes it the closest thing to a ground truth here.
- **cross-ride** — one bucket, every pass from two or more rides, as the spread
  about their mean. That mean is the value `mergeBuckets` actually draws, and
  one vote per pass is how it draws it.
- **terrain** — each bucket against the USGS 3DEP model, with production's own
  anchor applied and no second level removed. The only one of the three with a
  referent outside the archive, and the reason it exists: the other two are
  forms of the data agreeing with itself, which a systematically wrong ride can
  satisfy perfectly.

**It is a report, not a gate.** There is no second mode to compare against, so
nothing in it passes or fails; it exits non-zero only when a measure could not
be computed, or met a value that is not a number. Run it either side of a change
and compare by eye — that is what it is for, and the obvious use is a
`rebuild-model`, which recomputes every stored bucket and otherwise offers no
answer to "did that help?" beyond row counts.

Two cautions when comparing runs:

- Its terrain coverage is a floor. It uses the DEM values already cached in
  `segment_dem_elevations` and fetches nothing, while a rebuild calls
  `ensureDemElevations` and fills gaps in — so a rebuild can legitimately raise
  the terrain comparison count.
- Numbers from the older `eval:anchor` are **not** comparable to these. That
  script scored only buckets held out of its drift fit; with no fit there is
  nothing to hold out, so these populations are roughly twice the size.

## Endpoints

- `POST /sessions` — start a tracking session, returns `{ id, started_at }`
- `POST /sessions/:id/samples` — upload a batch of `{ recordedAt, lat, lon, elevationM, elevationSource, altitudeAccuracyM, headingDeg, speedMps, accuracyM }`. `elevationSource` is `"barometer"` or `"gps"`; it and `altitudeAccuracyM` are optional, so an older build of the app still uploads successfully and its samples land unlabelled.
- `POST /sessions/:id/end` — end the session; map-matches its samples to nearby segments and merges them into the running elevation model
- `GET /segments?minLon=&minLat=&maxLon=&maxLat=` — segments in a viewport, each with `directionalLines` (offset gradient geometry + color stops) ready for MapLibre

See `src/services/segmentMatcher.ts`, `elevationAggregator.ts`, and
`gradientBuilder.ts` for the core algorithms, and `src/db/schema.sql` for the
data model. `segments` must be populated first — see `../osm-pipeline`.
