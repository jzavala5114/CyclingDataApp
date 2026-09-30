-- Records that a segment has a structure over it, so no GPS fix is possible.
--
-- schema.sql is a fresh-install script (plain `create table`), so it cannot be
-- re-run against a database that already holds rides. This applies the same
-- change to an existing one. Idempotent: safe to run twice.
--
--   psql "$DATABASE_URL" -f src/db/migrations/002_segment_is_tunnel.sql
--
-- or, where psql is not installed (Windows, this machine):
--
--   npm run migrate -- src/db/migrations/002_segment_is_tunnel.sql
--
-- Purely additive with a default, so every existing row reads false -- "not
-- known to be covered" -- until osm-pipeline's `split` and `load` run and fill
-- it in. Nothing reads the column to change behaviour, so no rebuild is needed
-- and the running server is unaffected either way.

alter table segments
    add column if not exists is_tunnel boolean not null default false;

-- No index, deliberately. 73 of ~66k rows are true, the only reader is a
-- diagnostic run by hand, and a sequential scan of 66k rows costs milliseconds.
-- An index would add write cost to all 66,684 upserts `load` performs to buy
-- nothing. Add one when something on the request path reads this column.
