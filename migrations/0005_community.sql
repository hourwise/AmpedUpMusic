-- 0005_community.sql
--
-- AMPED-02A — the two inbound lists: `enquiries` and `mailing_list`.
-- Mirrors `Enquiry` and `MailingListSubscriber` in src/types/domain.ts.
--
-- `mailing_list.email` is unique, as the build plan requires. Uniqueness here
-- is deliberate and case-sensitive: normalising addresses (trim, lower-case)
-- belongs to the AMPED-10B write path, which owns the subscriber upsert. Doing
-- it here as a COLLATE NOCASE index would silently change what "the same
-- subscriber" means for every later read.
--
-- `bot_check_passed` records that a Turnstile token was verified server-side
-- (AMPED-10A). It defaults to 0 so that a row written without a verdict is
-- recorded as unverified rather than as trusted.

CREATE TABLE enquiries (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('artist', 'venue', 'promoter', 'general', 'press')),
  name             TEXT NOT NULL,
  email            TEXT NOT NULL,
  phone            TEXT,
  subject          TEXT,
  message          TEXT NOT NULL,
  links            TEXT,
  status           TEXT NOT NULL CHECK (status IN ('new', 'read', 'replied', 'archived', 'spam')),
  bot_check_passed INTEGER NOT NULL DEFAULT 0 CHECK (bot_check_passed IN (0, 1)),
  received_at      TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS received_at)
) STRICT;

CREATE INDEX enquiries_status_received_at_idx ON enquiries (status, received_at);

CREATE TABLE mailing_list (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  name            TEXT,
  status          TEXT NOT NULL CHECK (status IN ('subscribed', 'unsubscribed', 'bounced', 'pending')),
  consent_source  TEXT NOT NULL,
  consent_at      TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', consent_at) IS consent_at),
  unsubscribed_at TEXT CHECK (unsubscribed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', unsubscribed_at) IS unsubscribed_at)
) STRICT;

CREATE UNIQUE INDEX mailing_list_email_unique ON mailing_list (email);
