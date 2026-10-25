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

## Backups

Supabase's free plan keeps no backups, so this PC does:

```
npm run backup
```

It takes about a minute and writes an archive (pg_dump's own compressed
format, about 10MB) and a manifest beside it, the same name plus `.json`, into
`Documents/CyclingDataApp-backups` (`BACKUP_DIR` to change it; never inside
this repository, since a backup is every ride's GPS fixes). It only reads
production, over two connections, both encrypted (TLS required; the
certificate is not checked yet, which waits on the same fix for `pool.ts`).
One read-only transaction holds a snapshot while every table's rows, a
fingerprint of its contents and its definition (columns, constraints,
indexes, triggers, policies, row security) are measured, and pg_dump copies
that same snapshot. Sequences are the one thing a snapshot does not hold:
pg_dump reads them a moment later, so a ride saving meanwhile leaves them
ahead of the rows, never behind, which is all a restore needs. The manifest
records the values the archive holds, and the largest id each one numbers.

Before it dumps anything it refuses, writing nothing, a database it could not
hold all of. It copies the public schema, so it fails when:

- public holds no app tables (a new, empty project, say);
- a table `src/db/schema.sql` creates is missing;
- a schema other than public and Supabase's own holds tables;
- a table the last backup held is gone. If it was dropped on purpose, say
  so: `npm run backup -- --dropped=<table>`.

The archive is then read back, every table's rows and every sequence's value
counted out of it, and kept as `cyclingdataapp-<time>.dump.untested`. Last it
runs the restore test, whose result renames it:

| file | what it is |
|---|---|
| `cyclingdataapp-<time>.dump` | a backup: its restore test passed |
| `cyclingdataapp-<time>.dump.untested` | not yet tested; `npm run backup -- --no-restore-test` leaves it so |
| `cyclingdataapp-<time>.dump.failed` | not a backup: its archive check failed (the backup's output says why; no manifest) or its restore test did (the manifest's `restoreTests` says why) |
| `cyclingdataapp-<time>.dump.partial` | not a backup: pg_dump stopped partway (it failed, or the backup was stopped); safe to delete |

Only a `.dump` is a backup. The restore test on its own:

```
npm run backup:restore-test -- [archive]     # default: the newest .dump
```

That starts a throwaway PostgreSQL on this PC (a temp folder, 127.0.0.1 only,
a random password), restores the archive into it, measures every table there
the same way, checks rows, fingerprints, definitions and sequence values
against the manifest, then stops that server and deletes its folder. Each
result joins the manifest's `restoreTests`, oldest first, and an untested or
failed archive is renamed by it. A failure after a pass leaves a `.dump` a
backup, recorded beside the pass, unless the archive's bytes have changed
since; then it becomes `.dump.failed`. It runs with no database address in
its environment and refuses to start if one is set, and drops the shell's
`PG*` settings, so it can never reach production. Its folder,
`%TEMP%/cyclingdataapp-throwaway-restore-test-*`, is deleted on Ctrl-C or a
closed window too. A run killed outright (Task Manager, a crash) leaves its
server running behind its password, and the next restore test stops it and
deletes the folder.

`npm run eval:backup` runs both for real, in each situation the review of
2026-10-25 broke them, against a stand-in for production built from the newest
backup (TLS on, a certificate from Git for Windows' openssl). It takes about
two minutes and reaches no database but its stand-in. The scripts are in
`src/scripts`: `backupDatabase.ts`, `restoreDrill.ts`, `throwawayServer.ts`,
`backupFormat.ts`, `evalBackup.ts`.

**The tools, once per PC.** pg_dump must be the server's major version (17)
or newer, and the restore test needs a PostgreSQL server with PostGIS. Neither
is installed: EDB's portable zip and the PostGIS bundle are unpacked into
`%LOCALAPPDATA%/CyclingDataApp/pgsql-17` (`PG_BIN` points elsewhere). Nothing
runs in the background, and deleting that folder removes them. From Git Bash
(Windows' own `tar` reads zips; PostGIS goes in without overwriting, since 7
of its DLLs are the same libraries EDB ships, OpenSSL and zlib among them):

```
cd /tmp
curl -LO https://get.enterprisedb.com/postgresql/postgresql-17.11-2-windows-x64-binaries.zip
curl -LO https://download.osgeo.org/postgis/windows/pg17/postgis-bundle-pg17-3.6.2x64.zip
curl -LO https://download.osgeo.org/postgis/windows/pg17/postgis-bundle-pg17-3.6.2x64.zip.md5
md5sum postgis-bundle-pg17-3.6.2x64.zip; cat postgis-bundle-pg17-3.6.2x64.zip.md5   # the same
T="$LOCALAPPDATA/CyclingDataApp/pgsql-17"; mkdir -p x1 x2 "$T"
/c/Windows/System32/tar.exe -xf postgresql-17.11-2-windows-x64-binaries.zip -C x1 pgsql/bin pgsql/lib pgsql/share
/c/Windows/System32/tar.exe -xf postgis-bundle-pg17-3.6.2x64.zip -C x2 postgis-bundle-pg17-3.6.2x64/bin postgis-bundle-pg17-3.6.2x64/lib postgis-bundle-pg17-3.6.2x64/share
for d in bin lib share; do cp -rn x1/pgsql/$d/. "$T/$d/"; done
for d in bin lib share; do cp -rn x2/postgis-bundle-pg17-3.6.2x64/$d/. "$T/$d/"; done
"$T/bin/pg_dump.exe" --version     # pg_dump (PostgreSQL) 17.11
```

EDB's zip has no published checksum and its programs are unsigned
(`Get-AuthenticodeSignature` says NotSigned); what vouches for it is the HTTPS
download from EDB's own server. Set up this way 2026-10-25: 2,995 files,
417MB (this PC's copy also keeps the two projects' licence files).

**Restoring for real** is never scripted: it writes to a database, and which
one is a decision. Take the newest `.dump` (its manifest's `restoreTests` holds
a pass). Into a new, empty database (a new Supabase project, say), the way the
restore test does it, from Git Bash (the tools are not on PATH):

```
PG="$LOCALAPPDATA/CyclingDataApp/pgsql-17/bin"
"$PG/pg_restore.exe" --list "<archive>" | grep -v -E '^[0-9]+; +[0-9]+ +[0-9]+ +SCHEMA - public ' > restore.list
"$PG/pg_restore.exe" --no-owner --no-privileges --exit-on-error --use-list=restore.list --dbname="<new database's URL>" "<archive>"
```

The list leaves out `CREATE SCHEMA public`, which every database already has.
Tested against PostgreSQL 17.11 with PostGIS 3.6.2 (every restore test); not
yet against a new Supabase project.

## Tests and evals

```
npm test                # gate tests: deterministic, no database, well under 2s
npm run eval:quality    # where the elevation model stands, against the live archive
npm run eval:smoothing  # eval: the zero-phase elevation smoother
npm run eval:linker     # eval: what folding a sidewalk does to the drawn map
npm run eval:query-types  # eval: what every query returns, against the type the code declares
npm run eval:path       # eval: how a press-and-hold selection grows, on the stored rides
npm run eval:backup     # eval: the backup and its restore test, against a stand-in for production
```

`npm test` runs Node's built-in test runner through tsx. It needs nothing but
the source, so it is safe on any checkout. The first five evals read the live
database and write nothing; `eval:backup` reaches no database but the stand-in
it builds and deletes ("Backups").

`npm run eval:path` scores the fork rule of `GET /segments/path`
leave-one-ride-out: at every fork a stored ride passed, does the rule pick
the way that ride went, judged on the other rides' history? It exits 1
unless the rule as shipped beats both the least turn and the same rule
without its history, and also reports where
growth from every drawn line stops, what the 5 m snap buys, the route's
latency end to end in-process, and Ladders and Gold Camp Road against the
terrain model.

`npm run eval:query-types` asks the database for the column types of every
query under `src/` and checks each against the row type the code declares,
under the driver as `src/db/pgTypes.ts` configures it. The generic on
`db.query<T>` is an assertion node-postgres never sees, so this is the only
check that can tell a column declared `number` is arriving as text: the
compiler checks code against the declared type, and the tests feed it fixtures
built from that same declaration. It sends each statement as Parse + Describe
only, so nothing executes, not even an `INSERT ... RETURNING`, and the session
is read-only besides. Exits 1 on any lie; on any statement it could not
describe; on any query whose result is read but whose statement it cannot read
(built at runtime, or a Submittable such as `pg.Query`); on rows typed `any`
that the code reads; on a declared column that comes back under its
lower-cased name (an unquoted alias); when it finds no queries at all; and on
code the program runs that it cannot read, unless `ACCEPTED_OUTSIDE` in
`src/scripts/evalQueryTypes.ts` names it with why it is safe. One module is
named there today: osm-pipeline's `linkPlan.mjs`, which `evalLinkerFold.ts` runs
through a declaration file. An entry whose module is gone fails it too. **It
fails today, on purpose:** eleven `timestamptz` columns are declared `string`
and arrive as `Date` (see `context/session.md`). Run it after any change to a
query or a row type.

`npm run eval:linker` scores a **pipeline** decision by its effect on the
backend. `osm-pipeline/scripts/link_canonical.mjs` decides which segments are
match candidates, and this replays the real matcher, gate and stitcher over
every usable session with today's candidate set and again with the one the
frontage rule would produce — so "does folding these paths help, and what does
it cost" is answered before anything is written. Takes thresholds as an
argument (`npm run eval:linker 0.5,0.6,0.7`) and prints a per-line gained/lost
diff, because a net bucket count hides a street losing its line to a sidewalk
gaining one.

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
- `GET /segments/path?segmentId=&direction=&lon=&lat=[&atM=][&toSegmentId=&toDirection=&toLon=&toLat=[&toAtM=]][&grow=false][&avoid=id,id]`: the path a press-and-hold selection grows along, ahead from the pressed line in its own direction of travel: `pieces` (each with the map's own offset geometry in travel order, its data `source`, the `rule` that took it, and the rides behind it), `spans` (the slope of every stretch as the map colours it, with its height above the path's start, its rise and its rides), `stop` (why it ends: `end`, `fork` with its `branches` and the first 30 m of each, `gap`, `loop`, `limit`, or for a connection `joined` / `unreachable`; `aheadM` is how far past the selection's end, on ground with no data, that lies), and the colour `bands`. With a `to` point it first connects to it. A bad parameter is a 400. See `src/services/pathResponse.ts` for every field and `src/routes/segments.ts` for the three kinds of request.

See `src/services/segmentMatcher.ts`, `elevationAggregator.ts`, and
`gradientBuilder.ts` for the core algorithms, and `src/db/schema.sql` for the
data model. `segments` must be populated first — see `../osm-pipeline`.
