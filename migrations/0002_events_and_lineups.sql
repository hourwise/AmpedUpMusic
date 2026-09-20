-- 0002_events_and_lineups.sql
--
-- AMPED-02A — the diary: `events` and the `event_artists` line-up join.
-- Mirrors `Event` and `EventLineupEntry` in src/types/domain.ts.
--
-- `events.poster_asset_id` and `events.hero_asset_id` point forward at
-- `media_assets` (migration 0003); see the note in 0001.
--
-- Two documented rules from the domain model are enforced here rather than
-- left to the application:
--   * a cancelled or postponed event must carry a `status_message`, because
--     the notice is what stops a customer travelling to a gig that is off;
--   * `age_restriction` matches the `AgeRestriction` union exactly.

CREATE TABLE events (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  slug                   TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('draft', 'published', 'postponed', 'cancelled', 'completed', 'archived')),
  strapline              TEXT,
  description            TEXT NOT NULL,
  venue_id               TEXT NOT NULL REFERENCES venues (id) ON DELETE RESTRICT,
  doors_at               TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', doors_at) IS doors_at),
  starts_at              TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', starts_at) IS starts_at),
  ends_at                TEXT CHECK (ends_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', ends_at) IS ends_at),
  age_restriction        TEXT NOT NULL CHECK (age_restriction IN ('all-ages', '14-plus', '16-plus', '18-plus')),
  accessibility_notes    TEXT,
  poster_asset_id        TEXT REFERENCES media_assets (id) ON DELETE SET NULL,
  hero_asset_id          TEXT REFERENCES media_assets (id) ON DELETE SET NULL,
  link_instagram         TEXT,
  link_tiktok            TEXT,
  link_facebook          TEXT,
  link_youtube           TEXT,
  link_spotify           TEXT,
  link_bandcamp          TEXT,
  link_soundcloud        TEXT,
  link_website           TEXT,
  photography_credit     TEXT,
  photography_gallery_url TEXT,
  photography_photographer_url TEXT,
  internal_notes         TEXT,
  status_message         TEXT,
  rescheduled_to_event_id TEXT REFERENCES events (id) ON DELETE SET NULL,
  published_at           TEXT CHECK (published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', published_at) IS published_at),
  created_at             TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at             TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CHECK (status NOT IN ('cancelled', 'postponed') OR (status_message IS NOT NULL AND length(trim(status_message)) > 0))
) STRICT;

CREATE UNIQUE INDEX events_slug_unique ON events (slug);

CREATE INDEX events_status_starts_at_idx ON events (status, starts_at);

CREATE TABLE event_artists (
  event_id     TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  artist_id    TEXT NOT NULL REFERENCES artists (id) ON DELETE RESTRICT,
  position     INTEGER NOT NULL CHECK (position >= 0),
  billing_note TEXT,
  set_time     TEXT CHECK (set_time IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', set_time) IS set_time),
  PRIMARY KEY (event_id, artist_id)
) STRICT;

CREATE INDEX event_artists_artist_id_idx ON event_artists (artist_id);
