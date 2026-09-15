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
npm run eval:anchor     # eval: the drift anchor, against the live archive
npm run eval:smoothing  # eval: the zero-phase elevation smoother
```

`npm test` runs Node's built-in test runner through tsx. It needs nothing but
the source, so it is safe on any checkout. Both evals read the live database and
write nothing.

`npm run eval:anchor` measures whether the elevation model agrees with itself,
and with the ground. Three questions, all asked of buckets rather than raw
samples, because the anchor correction is applied on the way into a bucket and
never written back onto the sample rows:

- **self-consistency** — one ride, one bucket, two passes minutes apart. The
  ground cannot have moved, so any difference is the ride disagreeing with
  itself. Needs no second ride and no terrain model.
- **cross-ride** — one bucket, two rides. What actually reaches the map, since
  the running mean blends them.
- **terrain shape** — each held-out bucket against the terrain model, with the
  ride's own median residual removed first so it measures shape rather than
  level. The only one of the three with a referent outside the archive, and the
  reason it exists: the other two are both forms of the data agreeing with
  itself, and a correction that tilts a ride can improve both while walking the
  ride away from the ground. One did, by up to 12.39m, and scored better for it.

It prints a verdict against the population the change reached, and separately
proves that every untouched bucket came out identical — against an independent
transcription of `main`'s `fitDemOffset`, carrying its own literal constants, not
against the fitter under test. It also pairs each comparison with itself before
and after, because a summary median cannot tell "helped everything a little"
from "helped most and hurt some" — and if a quantile ever moves the wrong way,
that pairing is what says how many comparisons actually got worse instead of
leaving it to be waved away.

A note on the hold-out split it reports as out-of-sample: it splits by bucket,
and both halves come from the same two passes of the same runs. It controls for
per-bucket noise and nothing else. Every failure mode this fit actually has is a
property of the run and appears in both halves identically.

## Endpoints

- `POST /sessions` — start a tracking session, returns `{ id, started_at }`
- `POST /sessions/:id/samples` — upload a batch of `{ recordedAt, lat, lon, elevationM, elevationSource, altitudeAccuracyM, headingDeg, speedMps, accuracyM }`. `elevationSource` is `"barometer"` or `"gps"`; it and `altitudeAccuracyM` are optional, so an older build of the app still uploads successfully and its samples land unlabelled.
- `POST /sessions/:id/end` — end the session; map-matches its samples to nearby segments and merges them into the running elevation model
- `GET /segments?minLon=&minLat=&maxLon=&maxLat=` — segments in a viewport, each with `directionalLines` (offset gradient geometry + color stops) ready for MapLibre

See `src/services/segmentMatcher.ts`, `elevationAggregator.ts`, and
`gradientBuilder.ts` for the core algorithms, and `src/db/schema.sql` for the
data model. `segments` must be populated first — see `../osm-pipeline`.
