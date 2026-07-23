create table if not exists sources (
  id integer primary key,
  name text not null unique,
  platform text not null,
  source_type text not null,
  url_or_username text,
  weight real not null default 1.0,
  category text not null default 'structured_api',
  created_at text not null default current_timestamp
);

create table if not exists raw_tracks (
  id integer primary key,
  source_id integer not null references sources(id),
  platform_track_id text,
  raw_artist text not null,
  raw_title text not null,
  raw_album text,
  raw_url text,
  source_platform text,
  source_type text,
  source_name text,
  source_url text,
  source_weight real,
  source_context text,
  extraction_confidence real not null default 1.0,
  normalization_confidence real not null default 1.0,
  spotify_resolution_confidence real not null default 0.0,
  raw_payload_json text,
  harvested_at text not null default current_timestamp
);

create table if not exists normalized_tracks (
  id integer primary key,
  canonical_artist text not null,
  canonical_title text not null,
  canonical_album text,
  spotify_uri text,
  soundcloud_url text,
  musicbrainz_id text,
  first_seen_at text not null default current_timestamp,
  unique_key text not null unique
);

create table if not exists track_provenance (
  id integer primary key,
  normalized_track_id integer not null references normalized_tracks(id),
  source_id integer not null references sources(id),
  source_context text,
  playlist_title text,
  position integer,
  found_at text not null default current_timestamp
);

create table if not exists feedback (
  id integer primary key,
  normalized_track_id integer not null references normalized_tracks(id),
  rating text not null,
  note text,
  created_at text not null default current_timestamp
);

create table if not exists plays (
  id integer primary key,
  normalized_track_id integer not null references normalized_tracks(id),
  played_at text not null default current_timestamp,
  playlist_run_id integer references playlist_runs(id)
);

create table if not exists playlist_runs (
  id integer primary key,
  name text not null,
  mode text not null,
  created_at text not null default current_timestamp,
  written_to_spotify integer not null default 0,
  spotify_playlist_id text
);

create table if not exists source_errors (
  id integer primary key,
  source_id integer references sources(id),
  source_name text not null,
  message text not null,
  created_at text not null default current_timestamp
);

create table if not exists bridge_runs (
  id integer primary key,
  seed_type text not null,
  seed_values_json text not null,
  created_at text not null default current_timestamp
);

create table if not exists bridge_sources (
  id integer primary key,
  bridge_run_id integer not null references bridge_runs(id),
  source_id integer references sources(id),
  match_type text not null,
  confidence_score real not null default 0,
  matched_seeds_json text not null,
  seed_sides_json text not null default '[]',
  notes text,
  created_at text not null default current_timestamp
);
