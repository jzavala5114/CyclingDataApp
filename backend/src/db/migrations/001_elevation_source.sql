-- Records which sensor produced each sample's elevation.
--
-- schema.sql is a fresh-install script (plain `create table`), so it cannot be
-- re-run against a database that already holds rides. This applies the same
-- change to an existing one. Idempotent: safe to run twice.
--
--   psql "$DATABASE_URL" -f src/db/migrations/001_elevation_source.sql
--
-- Purely additive and nullable, so no rebuild is needed and rows recorded
-- before it stay null, meaning "unknown". Existing rides keep behaving exactly
-- as they do today.

alter table session_samples
    add column if not exists elevation_source text,
    add column if not exists altitude_accuracy_m double precision;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'session_samples_elevation_source_check'
    ) then
        alter table session_samples
            add constraint session_samples_elevation_source_check
            check (elevation_source in ('barometer', 'gps'));
    end if;
end $$;
