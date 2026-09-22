-- 0008_gallery_ordering.sql
--
-- AMPED-05B0 — persistent operator-controlled gallery ordering.
--
-- AMPED-05B requires a gallery's photo order to be set by the operator and
-- remembered. `media_assets` had no field for that: gallery reads were (and
-- still are) ordered by the event they belong to and then by id. This slice
-- adds the representation only; AMPED-05B owns reading and writing it.
--
-- Semantics:
--
--   gallery_position IS NULL      -> no explicit order yet (the accepted
--                                    id-ordered rendering still applies)
--   gallery_position >= 0         -> explicit operator-chosen position
--
-- One nullable integer. No gallery/album/collection table, no JSON ordering
-- column, no timestamp pretending to be an order, and no backfill: every
-- existing row becomes NULL and renders exactly as it does today.
--
-- Forward-only: 0001–0007 are accepted history and are not touched.

ALTER TABLE media_assets ADD COLUMN gallery_position INTEGER
  CHECK (gallery_position IS NULL OR gallery_position >= 0);
