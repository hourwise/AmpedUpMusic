-- 0007_artist_venue_archival.sql
--
-- AMPED-04C0 — a minimal archival state for reference data.
--
-- AMPED-04C needs to stop offering an artist or venue for *new* promotions
-- without destroying the history that already references it: an event's
-- venue_id and every event_artists row must survive untouched. There was no way
-- to represent that in 0001, and 0001 is accepted history, so the state arrives
-- here, exactly once, forward-only.
--
-- This is deliberately the smallest representation that works:
--
--   archived_at IS NULL      -> active, selectable for new promotions
--   archived_at IS NOT NULL  -> archived, historical only
--
-- No status enum, no is_active flag, no archived_by, no deleted_at, no soft
-- delete framework. Archiving deletes nothing and changes no id or slug; it
-- only records when an entity was retired, using the same canonical ISO-8601
-- UTC form (and CHECK) as every other timestamp in this schema.
--
-- Existing rows keep working untouched: a new nullable column is NULL for all
-- of them, so nothing is rewritten and nothing needs backfilling.

ALTER TABLE artists ADD COLUMN archived_at TEXT
  CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at) IS archived_at);

ALTER TABLE venues ADD COLUMN archived_at TEXT
  CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at) IS archived_at);
