-- 0003_media_and_social.sql
--
-- AMPED-02A — `media_assets` and `social_posts`.
-- Mirrors `MediaAsset` and `SocialPost` in src/types/domain.ts.
--
-- `storage_key` is the R2 object key from AMPED-05A; during AMPED-01/02A it
-- holds a committed path under public/media. It is unique because two rows
-- pointing at one object is how an asset gets deleted while still in use.
--
-- `alt` is NOT NULL with a non-blank CHECK: an image without alt text should
-- not be publishable, so it should not be storable either.
--
-- `url` is stored rather than derived from `storage_key`, so that moving the
-- bucket in AMPED-05A is a data backfill and not a code change.

CREATE TABLE media_assets (
  id          TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL,
  url         TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('poster', 'hero', 'gallery', 'artist', 'venue', 'og')),
  alt         TEXT NOT NULL CHECK (length(trim(alt)) > 0),
  width       INTEGER CHECK (width IS NULL OR width > 0),
  height      INTEGER CHECK (height IS NULL OR height > 0),
  mime_type   TEXT NOT NULL,
  byte_size   INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  credit      TEXT,
  event_id    TEXT REFERENCES events (id) ON DELETE CASCADE,
  artist_id   TEXT REFERENCES artists (id) ON DELETE CASCADE,
  uploaded_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', uploaded_at) IS uploaded_at)
) STRICT;

CREATE UNIQUE INDEX media_assets_storage_key_unique ON media_assets (storage_key);

CREATE INDEX media_assets_event_id_idx ON media_assets (event_id);

CREATE INDEX media_assets_artist_id_idx ON media_assets (artist_id);

CREATE TABLE social_posts (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT REFERENCES events (id) ON DELETE CASCADE,
  network            TEXT NOT NULL CHECK (network IN ('instagram', 'tiktok', 'facebook', 'youtube', 'spotify', 'bandcamp', 'soundcloud', 'website')),
  url                TEXT NOT NULL,
  caption            TEXT,
  thumbnail_asset_id TEXT REFERENCES media_assets (id) ON DELETE SET NULL,
  posted_at          TEXT CHECK (posted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', posted_at) IS posted_at),
  featured           INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1))
) STRICT;

CREATE INDEX social_posts_event_id_idx ON social_posts (event_id);

CREATE INDEX social_posts_featured_idx ON social_posts (featured);
