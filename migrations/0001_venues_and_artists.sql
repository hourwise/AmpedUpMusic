-- 0001_venues_and_artists.sql
--
-- AMPED-02A — reference data: the rooms Amped Up promotes in, and the acts
-- that play them. Mirrors `Venue` and `Artist` in src/types/domain.ts.
--
-- Conventions used by every migration in this directory:
--   * tables are STRICT, so a REAL can never be stored in an INTEGER column
--     and money can never quietly become a float;
--   * money is an INTEGER number of pence, named *_pence;
--   * every timestamp is a TEXT column holding canonical ISO-8601 UTC
--     ("2026-11-14T19:30:00.000Z"), enforced by a CHECK;
--   * booleans are INTEGER 0/1, enforced by a CHECK;
--   * every status column carries a CHECK listing exactly the values in the
--     matching TypeScript union - no extra states are invented here.
--
-- `artists.image_asset_id` points forward at `media_assets`, which migration
-- 0003 creates. SQLite allows that; the seed inserts media before it writes
-- the column, and ON DELETE SET NULL keeps the pair consistent.

CREATE TABLE venues (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL,
  address_line1      TEXT NOT NULL,
  address_line2      TEXT,
  city               TEXT NOT NULL,
  postcode           TEXT NOT NULL,
  standard_notes     TEXT,
  accessibility_info TEXT,
  capacity           INTEGER CHECK (capacity IS NULL OR capacity >= 0),
  website_url        TEXT,
  map_url            TEXT,
  created_at         TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at         TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at)
) STRICT;

CREATE UNIQUE INDEX venues_slug_unique ON venues (slug);

CREATE TABLE artists (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL,
  tagline        TEXT,
  biography      TEXT,
  genre          TEXT,
  based_in       TEXT,
  image_asset_id TEXT REFERENCES media_assets (id) ON DELETE SET NULL,
  link_instagram TEXT,
  link_tiktok    TEXT,
  link_facebook  TEXT,
  link_youtube   TEXT,
  link_spotify   TEXT,
  link_bandcamp  TEXT,
  link_soundcloud TEXT,
  link_website   TEXT,
  created_at     TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at     TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at)
) STRICT;

CREATE UNIQUE INDEX artists_slug_unique ON artists (slug);
