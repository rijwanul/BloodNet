-- ============================================================
-- BloodNet v2 (bnetv2) - mega-batch migration
-- Run ONCE against the EXISTING remote bnetv2_db. Do NOT re-run -
-- several statements below (ALTER TABLE ADD COLUMN, the donations/
-- seek_exclusions rebuilds) will error if applied a second time.
-- wrangler d1 execute bnetv2_db --remote --file=./migration_mega_batch.sql
-- ============================================================

PRAGMA foreign_keys = OFF;

-- ------------------------------------------------------------
-- 1. donations: donation_date becomes nullable (undated-but-
--    hospital-remembered entries get their own row instead of
--    folding into the anonymous extra_donation_count bucket).
--    SQLite can't ALTER a column to drop NOT NULL directly, so
--    this rebuilds the table. Existing rows all have a real
--    date already, so the copy is lossless.
-- ------------------------------------------------------------
CREATE TABLE donations_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hospital_name  TEXT DEFAULT NULL,
  donation_date  TEXT DEFAULT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO donations_new (id, user_id, hospital_name, donation_date, created_at)
  SELECT id, user_id, hospital_name, donation_date, created_at FROM donations;
DROP TABLE donations;
ALTER TABLE donations_new RENAME TO donations;
CREATE INDEX IF NOT EXISTS idx_donations_user ON donations(user_id, donation_date DESC);

-- ------------------------------------------------------------
-- 2. seek_exclusions: rebuild to add blood_group as part of the
--    composite key (was requester_id+donor_id only - locks are
--    now scoped per blood group, see the KV-lock bugfix). This
--    table is transient session-exclusion data, so old rows are
--    safe to drop rather than backfill.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS seek_exclusions;
CREATE TABLE seek_exclusions (
  requester_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  donor_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blood_group    TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (requester_id, donor_id, blood_group)
);
CREATE INDEX IF NOT EXISTS idx_seek_exclusions_requester ON seek_exclusions(requester_id, created_at);

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- 3. users: new columns from this session's work.
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN public_profile_view TEXT NOT NULL DEFAULT 'tabs';
ALTER TABLE users ADD COLUMN sms_user_initiated_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sms_system_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sms_count_date TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN sms_user_initiated_limit_override INTEGER DEFAULT NULL;
ALTER TABLE users ADD COLUMN sms_system_limit_override INTEGER DEFAULT NULL;
ALTER TABLE users ADD COLUMN sms_highest_daily_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sms_highest_daily_date TEXT DEFAULT NULL;

-- ------------------------------------------------------------
-- 4. New table: SMS highest-daily-count history ("Previous
--    Highest Daily SMS Receivers" list).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_daily_record_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mobile       TEXT NOT NULL,
  count        INTEGER NOT NULL,
  record_date  TEXT NOT NULL,
  reset_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_daily_record_history_reset ON sms_daily_record_history(reset_at DESC);

-- ------------------------------------------------------------
-- 5. New settings keys. INSERT OR IGNORE is safe to re-run on
--    its own (existing keys are left untouched) even though the
--    rest of this file is not.
-- ------------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('show_logout_button', '0'),
  ('reserved_usernames', ''),
  ('mask_visible_digits', '4'),
  ('activity_log_auto_purge_enabled', '0'),
  ('activity_log_auto_purge_days', '30'),
  ('sms_daily_limit_user_initiated', '3'),
  ('sms_daily_limit_system', '3'),
  ('sms_over_limit_otp_message', 'আপনার দৈনিক এসএমএস লিমিট শেষ হয়েছে। 01883-600680 নাম্বারে কল করুন'),
  ('sms_highest_daily_reset_month', '');
