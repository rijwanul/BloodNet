-- Migration: add donation-reminder / eligibility-note fields to users,
-- plus the new seek_exclusions table.
-- Safe to run once against the EXISTING bnetv2_db (tables/rows already present).
-- Do NOT re-run schema.sql alone for this - CREATE TABLE IF NOT EXISTS is a
-- no-op on a table that already exists, so it will not add these columns.

ALTER TABLE users ADD COLUMN pending_donation_prompt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pending_donation_prompt_at TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN donation_reminder_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_eligibility_change_note TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS seek_exclusions (
  requester_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  donor_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (requester_id, donor_id)
);
CREATE INDEX IF NOT EXISTS idx_seek_exclusions_requester ON seek_exclusions(requester_id, created_at);

-- New settings keys used by the donation-reminder / call-status features.
-- INSERT OR IGNORE is safe to re-run - existing keys are left untouched,
-- only missing keys get inserted.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('call_status_timer_seconds', '20'),
  ('show_seek_option', '1'),
  ('show_join_option', '1'),
  ('profile_share_base_url', ''),
  ('default_avatars_json', '[]'),
  ('sms_enabled_eligibility_change_by_call', '1'),
  ('sms_eligibility_change_by_call', 'আপনার এলিজিবিলিটি একটি কলের কারণে পরিবর্তন হয়েছে। ষ্ট্যাটাস: {status}'),
  ('sms_enabled_donation_reminder', '1'),
  ('sms_donation_reminder', '({siteTitle}) সম্প্রতি রক্তদান করেছেন? এন্ট্রি বা ষ্ট্যাটাস আপডেট করে নিন!');
