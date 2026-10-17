-- Keeps each pass's own height at every bucket it covered, so the map can fit a
-- slope to each pass instead of to the mean of all of them.
--
-- schema.sql is a fresh-install script (plain `create table`), so it cannot be
-- re-run against a database that already holds rides. This applies the same
-- change to an existing one. Idempotent: safe to run twice.
--
--   npm run migrate -- src/db/migrations/003_pass_buckets.sql
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT USES IT. processSession writes a
-- row here for every bucket of every pass it merges, and GET /segments reads
-- them, so a server running that code against a database without this table
-- fails every ride save and every map request. The other order is safe: the
-- server running today never touches the table.
--
-- Purely additive. The table starts empty, and the map draws a window from the
-- stored means unless every pass behind them is on file here, so applying this
-- changes nothing anyone sees. Rows arrive as rides are merged: every new ride
-- from the deploy on, and every older one at the next rebuild. rebuildModel.ts
-- needs no change for that: its `delete from session_segment_matches` empties
-- this table through the cascade below.

create table if not exists segment_pass_buckets (
    match_id     bigint not null references session_segment_matches(id) on delete cascade,
    distance_m   integer not null,
    elevation_m  double precision not null,
    primary key (match_id, distance_m)
);

-- No index beyond the key, deliberately. The map finds a segment's passes
-- through session_segment_matches_segment_idx and then this key, whose leading
-- column is match_id; the same key serves the cascade.
