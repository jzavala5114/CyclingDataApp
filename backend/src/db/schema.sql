-- Prototype schema. Run against a Postgres database with PostGIS enabled.
create extension if not exists postgis;

-- Supabase's public API roles get nothing on what this creates. Supabase gives
-- `anon` and `authenticated` everything on every table, sequence and function
-- the creating role makes in public, through its default privileges, and the
-- project's anon key that acts as `anon` is public by design. Taking that
-- default away first means no table below is ever open, not even between its
-- `create table` and its `enable row level security`. On a database without
-- those roles (plain PostgreSQL) this does nothing. The same change for the
-- live database is migrations/004_row_level_security.sql.
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('alter default privileges in schema public revoke all on tables from %I', api_role);
      execute format('alter default privileges in schema public revoke all on sequences from %I', api_role);
      execute format('alter default privileges in schema public revoke all on functions from %I', api_role);
    end if;
  end loop;
end $$;

-- Every table below also has row level security on, with no policies: no row
-- is visible to a role it applies to. The backend connects as the tables'
-- owner, which it does not apply to, so the backend reads and writes as
-- before. src/db/rowSecurity.test.ts fails a table created without it.

-- One row per OSM way segment (a way pre-split at intersection nodes by
-- osm-pipeline). Direction is not stored here -- "forward" always means
-- travelling from start_node_id to end_node_id along `geom`, "backward" is
-- the reverse. Both directions share this one geometry row.
create table segments (
    id              bigserial primary key,
    osm_way_id      bigint not null,
    kind            text not null check (kind in ('road', 'cycleway', 'footway')),
    -- OSM footway=sidewalk. Only these get folded into a parent road; trails
    -- and connectors keep their own gradient even where they run beside one.
    is_sidewalk     boolean not null default false,
    -- There is a structure over this segment, so no GPS fix is possible on it:
    -- OSM `tunnel` set to anything but no/false, or `covered=yes`. See
    -- osm-pipeline/scripts/lib/tags.mjs for the rule and what it excludes
    -- (notably `layer=-1`, which is a grade separation, not a roof).
    --
    -- Nothing reads this to change behaviour. It exists so an unpainted
    -- stretch can be told apart from a lost one: a hole in a drawn line is
    -- physics under a tunnel and a defect anywhere else, and without the flag
    -- every count of the second is inflated by the first.
    is_tunnel       boolean not null default false,
    street_name     text,
    start_node_id   bigint not null,
    end_node_id     bigint not null,
    -- Over-long runs get cut into equal pieces that share the same pair of
    -- OSM end nodes, so the piece index is part of a segment's identity.
    piece_index     integer not null default 0,
    -- A sidewalk running alongside a street is the same physical route as
    -- that street, and a typical downtown road here has 3-4 of them mapped
    -- separately. Matching against all of them scattered one ride across
    -- several parallel lines, so each is pointed at its parent road and only
    -- canonical segments (this column null) are matched or drawn. Standalone
    -- trails have no parent and stay canonical in their own right.
    canonical_segment_id bigint references segments(id) on delete set null,
    geom            geometry(LineString, 4326) not null,
    length_m        double precision not null,
    bearing_deg     double precision not null, -- compass bearing of the forward direction
    created_at      timestamptz not null default now()
);
alter table segments enable row level security;

create index segments_canonical_idx on segments (canonical_segment_id);

create index segments_geom_idx on segments using gist (geom);
create unique index segments_way_start_end_idx
    on segments (osm_way_id, start_node_id, end_node_id, piece_index);

-- A tracking session: start button pressed to stop button pressed.
create table sessions (
    id          bigserial primary key,
    started_at  timestamptz not null,
    ended_at    timestamptz,
    device_info text
);
alter table sessions enable row level security;

-- Raw GPS + barometric samples captured during a session, before any
-- map-matching happens. This is the "elevation" dataset -- it knows nothing
-- about segments yet.
create table session_samples (
    id            bigserial primary key,
    session_id    bigint not null references sessions(id) on delete cascade,
    recorded_at   timestamptz not null,
    lat           double precision not null,
    lon           double precision not null,
    elevation_m   double precision not null,
    -- Which sensor produced elevation_m. expo-sensors has no background
    -- counterpart to expo-location's task, so the barometer stops delivering
    -- when the screen locks and the phone falls back to GPS altitude, which is
    -- ~100x worse vertically. Without this column that swap is invisible:
    -- measured roughness splits the archive into rides at 0.35-0.49m (the
    -- barometer working) and rides at 0.7-6.4m, but only by inference.
    -- Null on rows recorded before this column existed.
    elevation_source text check (elevation_source in ('barometer', 'gps')),
    -- Vertical accuracy, in metres, as reported by the OS. Unrelated to
    -- accuracy_m below, which is horizontal -- a fix can sit within 4m
    -- horizontally while its altitude is out by 15.
    altitude_accuracy_m double precision,
    heading_deg   double precision,
    speed_mps     double precision,
    accuracy_m    double precision
);
alter table session_samples enable row level security;

-- Unique rather than a plain index, so re-uploading a chunk whose response was
-- lost in transit is a no-op instead of a duplicate. Uploads are retried and
-- resumed from the phone, and two fixes in one session cannot share a
-- timestamp -- the location provider is capped at one per second.
create unique index session_samples_session_idx on session_samples (session_id, recorded_at);

-- Output of segmentMatcher: which contiguous stretch of a session covers
-- which segment, in which direction. Kept for auditability/debugging.
create table session_segment_matches (
    id                  bigserial primary key,
    session_id          bigint not null references sessions(id) on delete cascade,
    segment_id          bigint not null references segments(id) on delete cascade,
    direction           text not null check (direction in ('forward', 'backward')),
    first_sample_id     bigint not null references session_samples(id),
    last_sample_id      bigint not null references session_samples(id),
    matched_at          timestamptz not null default now()
);
alter table session_segment_matches enable row level security;

create index session_segment_matches_segment_idx on session_segment_matches (segment_id, direction);

-- Terrain elevation from a public digital elevation model (USGS 3DEP),
-- sampled along segment centrelines at the same positions the buckets below
-- use, so a ride can be compared against it point for point.
--
-- This is a reference frame, not data the map draws. A barometer measures
-- change in altitude well and absolute altitude not at all, so each ride is
-- anchored to the GPS altitude of its own first fix -- one reading carrying
-- 10-20m of error, which differed by 3.3m across sessions 11-14 and put an
-- invented step in the road wherever two rides met. Fitting an offset per
-- session against these values removes that without touching the shape of
-- the profile.
--
-- These set a ride's LEVEL only. They do not set its slope over time, even
-- though the barometer does slide during a ride: within one ride, where you
-- are is correlated with when you are, so a line fitted against these absorbs
-- the terrain model's own place-dependent error and tilts the ride. Measured,
-- that made rides agree with each other worse. The slope comes from places a
-- ride visited twice instead, where the ground cancels. See anchorFit.ts.
--
-- Cached permanently: terrain does not move, and the source is a rate-limited
-- public API. Direction is part of the key only so lookups line up exactly
-- with the bucket grid; the terrain itself has no direction.
create table segment_dem_elevations (
    segment_id   bigint not null references segments(id) on delete cascade,
    direction    text not null check (direction in ('forward', 'backward')),
    distance_m   integer not null,
    elevation_m  double precision not null, -- orthometric (NAVD88), unlike GPS
    fetched_at   timestamptz not null default now(),
    primary key (segment_id, direction, distance_m)
);
alter table segment_dem_elevations enable row level security;

-- How much of each segment has actually been ridden, in each direction, as a
-- distance range measured along the direction of travel.
--
-- Kept separately from the buckets because it is a property of the coverage,
-- not of any one measurement, and it cannot be recovered from the buckets
-- afterwards: those sit on a 15m grid, so the first one is up to 7.5m inside
-- where the ride really began. Inferring the extent from them left a fixed
-- ~7.5m hole at the head of most lines -- an artifact of the grid that no
-- amount of extra riding would have filled.
--
-- The range is the union across every ride, so repeated passes widen it the
-- same way they refine the elevations.
create table segment_coverage (
    segment_id     bigint not null references segments(id) on delete cascade,
    direction      text not null check (direction in ('forward', 'backward')),
    covered_from_m double precision not null,
    covered_to_m   double precision not null,
    updated_at     timestamptz not null default now(),
    primary key (segment_id, direction)
);
alter table segment_coverage enable row level security;

-- The refined, crowdsourced elevation model: one row per (segment,
-- direction, distance bucket). elevation_m is a running mean across every
-- session that has touched this bucket -- elevationAggregator updates it in
-- place rather than inserting duplicate rows.
create table segment_elevation_buckets (
    segment_id      bigint not null references segments(id) on delete cascade,
    direction       text not null check (direction in ('forward', 'backward')),
    distance_m      integer not null, -- distance along the segment in the given direction, rounded to bucket_size_m
    elevation_m     double precision not null,
    sample_count    integer not null default 0,
    updated_at      timestamptz not null default now(),
    primary key (segment_id, direction, distance_m)
);
alter table segment_elevation_buckets enable row level security;

-- Each pass's own height at every bucket it covered: the values the running
-- means above were built from, one row per pass per bucket, filed under the
-- pass's match row.
--
-- The means alone draw cliffs. Every ride is lined up with the terrain model
-- by one offset, and a barometer drifts during a ride, so two passes over the
-- same ground can sit metres apart. Where they cover different stretches of a
-- line, a mean changes membership from one bucket to the next and their level
-- difference reads as a climb: the Ridgeway trailhead lot drew +25% on ground
-- the terrain model puts at 3 to 6%. Fitting each pass's own slope removes the
-- levels from it. gradientBuilder.ts does that only where these rows account
-- for every pass in a window's means, and draws from the means otherwise.
--
-- Added to a live database by migrations/003_pass_buckets.sql.
create table segment_pass_buckets (
    match_id     bigint not null references session_segment_matches(id) on delete cascade,
    distance_m   integer not null,
    elevation_m  double precision not null,
    primary key (match_id, distance_m)
);
alter table segment_pass_buckets enable row level security;
