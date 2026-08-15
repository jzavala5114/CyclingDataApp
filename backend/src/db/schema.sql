-- Prototype schema. Run against a Postgres database with PostGIS enabled.
create extension if not exists postgis;

-- One row per OSM way segment (a way pre-split at intersection nodes by
-- osm-pipeline). Direction is not stored here -- "forward" always means
-- travelling from start_node_id to end_node_id along `geom`, "backward" is
-- the reverse. Both directions share this one geometry row.
create table segments (
    id              bigserial primary key,
    osm_way_id      bigint not null,
    kind            text not null check (kind in ('road', 'cycleway', 'footway')),
    street_name     text,
    start_node_id   bigint not null,
    end_node_id     bigint not null,
    -- Over-long runs get cut into equal pieces that share the same pair of
    -- OSM end nodes, so the piece index is part of a segment's identity.
    piece_index     integer not null default 0,
    geom            geometry(LineString, 4326) not null,
    length_m        double precision not null,
    bearing_deg     double precision not null, -- compass bearing of the forward direction
    created_at      timestamptz not null default now()
);

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
    heading_deg   double precision,
    speed_mps     double precision,
    accuracy_m    double precision
);

create index session_samples_session_idx on session_samples (session_id, recorded_at);

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

create index session_segment_matches_segment_idx on session_segment_matches (segment_id, direction);

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
