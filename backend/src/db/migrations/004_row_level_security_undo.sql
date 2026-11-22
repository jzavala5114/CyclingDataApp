-- Reverses 004_row_level_security.sql exactly, back to the grants Supabase
-- made: row level security off on the eight tables, and `anon` and
-- `authenticated` given everything again on them, their sequences and
-- `postgres`'s later tables, sequences and functions in public. (004 also
-- revokes PUBLIC's grants on these; there were none before it, so there are
-- none to give back.)
--
-- ONLY to undo 004 on the live database, if something it was not expected to
-- touch turns out to need the API's roles. This REOPENS every ride's GPS fixes
-- to anyone holding the project's anon key whenever the Data API is on. It is
-- never part of setting up a database.
--
-- One statement, so all or nothing however it is run, like 004.
--
--   npm run migrate -- src/db/migrations/004_row_level_security_undo.sql --apply
--
-- `npm run eval:security-migration` applies 004, this, then 004 again on a
-- stand-in, and checks this leaves every grant, default and flag as it found
-- them before 004.

do $$
begin
  alter table public.segments                  disable row level security;
  alter table public.sessions                  disable row level security;
  alter table public.session_samples           disable row level security;
  alter table public.session_segment_matches   disable row level security;
  alter table public.segment_dem_elevations    disable row level security;
  alter table public.segment_coverage          disable row level security;
  alter table public.segment_elevation_buckets disable row level security;
  alter table public.segment_pass_buckets      disable row level security;

  grant all on table
      public.segments, public.sessions, public.session_samples,
      public.session_segment_matches, public.segment_dem_elevations,
      public.segment_coverage, public.segment_elevation_buckets,
      public.segment_pass_buckets
    to anon, authenticated;

  grant all on sequence
      public.segments_id_seq, public.sessions_id_seq,
      public.session_samples_id_seq, public.session_segment_matches_id_seq
    to anon, authenticated;

  alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated;
  alter default privileges for role postgres in schema public grant all on functions to anon, authenticated;
end $$;
