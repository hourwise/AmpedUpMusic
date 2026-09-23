-- 0009_social_featured_ordering.sql
--
-- AMPED-05C0 — persistent operator-controlled featured-social ordering.
--
-- The AMPED-05C preflight stopped because `social_posts` had no field that can
-- honestly represent an explicit homepage strip order: `id` and `posted_at`
-- are not operator decisions, and there was nothing else. This migration adds
-- the representation only; AMPED-05C owns feature/unfeature, normalisation,
-- reorder and the homepage query.
--
-- Semantics:
--
--   featured_position IS NULL  -> no explicit persisted position yet (the
--                                 accepted id-ordered read still applies)
--   featured_position >= 0     -> explicit featured-strip position
--
-- One nullable integer. No ordering table, no JSON, no timestamp proxy, no
-- partial unique index and no status enum. There is deliberately NO
-- cross-constraint with `featured`: existing featured rows may legitimately
-- migrate with NULL until AMPED-05C normalises them, and behavioural
-- consistency is AMPED-05C's job.
--
-- Forward-only: 0001–0008 are accepted history and are not touched. No
-- backfill: every existing row keeps its data and becomes NULL.

ALTER TABLE social_posts ADD COLUMN featured_position INTEGER
  CHECK (featured_position IS NULL OR featured_position >= 0);
