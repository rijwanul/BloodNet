-- Migration: eligibility-reopened SMS reminder (corrected design).
-- Run ONCE against the EXISTING remote bnetv2_db.
--
-- IMPORTANT: if you already ran a previous migration_eligibility_reopened_sms.sql
-- that added a column called eligibility_reopen_note_sent (a plain 0/1
-- flag, from an earlier and incorrect version of this feature), this file
-- drops that column and replaces it with the two columns actually needed
-- for the delay/repeat-window design. If you have NOT run that earlier
-- migration, the DROP COLUMN line below will simply do nothing useful -
-- SQLite's DROP COLUMN on a non-existent column errors, so in that case
-- skip the DROP COLUMN line entirely (comment it out or delete it) before
-- running this file. Check first with:
--   wrangler d1 execute bnetv2_db --remote --command="PRAGMA table_info(users);"
-- and look for eligibility_reopen_note_sent in the output.

-- Only run this line if eligibility_reopen_note_sent exists:
-- ALTER TABLE users DROP COLUMN eligibility_reopen_note_sent;

ALTER TABLE users ADD COLUMN eligibility_off_since TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN eligibility_reopen_note_sent_at TEXT DEFAULT NULL;

-- Safe to re-run on its own - INSERT OR IGNORE skips keys that already exist.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('sms_eligibility_reopened', '{siteTitle} রক্তদানের সময় হয়েছে। করে থাকলে প্রোফাইল আপডেট করে নিন এখনই!'),
  ('sms_enabled_eligibility_reopened', '1'),
  ('eligibility_reopen_delay_days', '15'),
  ('eligibility_reopen_repeat_days', '15');
