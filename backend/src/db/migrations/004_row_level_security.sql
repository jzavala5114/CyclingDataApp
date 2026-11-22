-- Closes the app's tables to Supabase's public API roles, `anon` and
-- `authenticated`: row level security on, and every grant they hold taken back.
--
-- What was open, read-only on 2026-10-25 and again on 2026-11-22: both roles
-- could select, insert, update, delete and truncate all eight tables and use
-- all four sequences, through Supabase's Data API, with the project's anon key,
-- which is public by design. That is every ride's GPS fixes, readable and
-- deletable by anyone holding the key. Nothing used it (no statement in
-- pg_stat_statements ran as either role), and Julian switched the Data API off
-- on 2026-10-25, which is what closed it in the meantime. Supabase's advisor
-- reported it as "RLS Disabled in Public" and "Sensitive Columns Exposed".
--
-- Why the revokes as well as row level security: row level security filters
-- rows, and some privileges never meet a row. TRUNCATE empties a table without
-- reading one, REFERENCES and TRIGGER act on the table's definition, and a
-- sequence has no rows at all. With the grants gone (PUBLIC's too, which every
-- role holds), the API's roles can do nothing here, whatever the policies;
-- there are none, which under row level security means no row is visible to
-- anyone it applies to.
--
-- Safe for the backend. It connects as `postgres`, which owns every one of these
-- tables and sequences: an owner is exempt from its own table's row level
-- security unless FORCE is set (it is not, here), and `postgres` also holds
-- BYPASSRLS. Every grant revoked here was made by `postgres` (grantor
-- `/postgres` in each relacl), so `postgres` can take each one back.
--
-- And for later tables and sequences: `postgres`'s default privileges in
-- public gave both roles everything on every table, sequence and function it
-- created. They give them nothing from now on, so a table a later migration
-- creates is closed before that migration enables its row level security
-- (which src/db/rowSecurity.test.ts requires of every table any migration
-- creates). Functions are the exception PostgreSQL makes: every new function
-- is executable by PUBLIC, by a default that only a change for every schema
-- at once could remove, and that would also strip it from functions an
-- extension installed later creates. So a function of ours revokes EXECUTE
-- from PUBLIC itself (rowSecurity.test.ts requires that too), and `npm run
-- eval:security` fails any function of ours the API's roles can execute.
--
-- Not touched, and why:
--   - service_role: Supabase's admin key. It bypasses row level security by
--     design and keeps its grants; the app has never held that key.
--   - what PostGIS owns in public (spatial_ref_sys, geometry_columns,
--     geography_columns, 744 functions): supabase_admin installed it, owns
--     them and made their grants, so `postgres` can change none of them.
--     The Data API being off is what keeps them closed to the outside.
--
-- One statement, so it is all or nothing however it is run (`npm run
-- migrate`, `psql -f`, Supabase's SQL editor): the check at its end raises if
-- anything above is still open, and then nothing here is changed. It waits at
-- most 5 seconds for each table's lock (a backup's pg_dump holds one on every
-- table while it runs) and gives up rather than hold presses behind it; run it
-- again later. Idempotent: safe to run twice. Needs PostgreSQL 17 or later for
-- MAINTAIN (production runs 17.6). Reversed exactly by
-- 004_row_level_security_undo.sql.
--
--   npm run migrate -- src/db/migrations/004_row_level_security.sql
--   npm run migrate -- src/db/migrations/004_row_level_security.sql --apply
--   npm run eval:security
--
-- schema.sql does the same for a new database.

do $$
declare
  still_open text;
begin
  perform set_config('lock_timeout', '5s', true);

  alter table public.segments                  enable row level security;
  alter table public.sessions                  enable row level security;
  alter table public.session_samples           enable row level security;
  alter table public.session_segment_matches   enable row level security;
  alter table public.segment_dem_elevations    enable row level security;
  alter table public.segment_coverage          enable row level security;
  alter table public.segment_elevation_buckets enable row level security;
  alter table public.segment_pass_buckets      enable row level security;

  revoke all on table
      public.segments, public.sessions, public.session_samples,
      public.session_segment_matches, public.segment_dem_elevations,
      public.segment_coverage, public.segment_elevation_buckets,
      public.segment_pass_buckets
    from anon, authenticated, public;

  revoke all on sequence
      public.segments_id_seq, public.sessions_id_seq,
      public.session_samples_id_seq, public.session_segment_matches_id_seq
    from anon, authenticated, public;

  alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
  alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
  alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

  -- A REVOKE that finds nothing to take back only warns (a grant someone else
  -- made, say), so this checks the result rather than trusting the above.
  with app(rel) as (
         values ('public.segments'::regclass), ('public.sessions'::regclass),
                ('public.session_samples'::regclass), ('public.session_segment_matches'::regclass),
                ('public.segment_dem_elevations'::regclass), ('public.segment_coverage'::regclass),
                ('public.segment_elevation_buckets'::regclass), ('public.segment_pass_buckets'::regclass)),
       seqs(rel) as (
         values ('public.segments_id_seq'::regclass), ('public.sessions_id_seq'::regclass),
                ('public.session_samples_id_seq'::regclass), ('public.session_segment_matches_id_seq'::regclass)),
       api(role) as (values ('anon'), ('authenticated')),
       table_privilege(p) as (
         values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')),
       column_privilege(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')),
       sequence_privilege(p) as (values ('USAGE'), ('SELECT'), ('UPDATE')),
       problems(problem) as (
         select format('%s: row level security is off', c.oid::regclass)
           from app join pg_class c on c.oid = app.rel
          where not c.relrowsecurity
         union all
         select format('%s: %s may %s', app.rel, api.role, table_privilege.p)
           from app, api, table_privilege
          where has_table_privilege(api.role, app.rel, table_privilege.p)
         union all
         select format('%s: %s may %s a column', app.rel, api.role, column_privilege.p)
           from app, api, column_privilege
          where has_any_column_privilege(api.role, app.rel, column_privilege.p)
         union all
         select format('%s: %s may %s', seqs.rel, api.role, sequence_privilege.p)
           from seqs, api, sequence_privilege
          where has_sequence_privilege(api.role, seqs.rel, sequence_privilege.p)
         union all
         select format('postgres''s default privileges in public still grant %s on %s', g.grantee::regrole, d.defaclobjtype)
           from pg_default_acl d, aclexplode(d.defaclacl) g
          where d.defaclrole::regrole::text = 'postgres'
            and d.defaclnamespace::regnamespace::text = 'public'
            and g.grantee <> 0
            and g.grantee::regrole::text in ('anon', 'authenticated'))
  select string_agg(problem, '; ' order by problem) into still_open from problems;
  if still_open is not null then
    raise exception 'row level security migration left these open: %', still_open;
  end if;
end $$;
