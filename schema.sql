-- BloodNet v2 (bnetv2) D1 Schema
-- SQLite dialect (Cloudflare D1)

PRAGMA foreign_keys = ON;

-- ============================================================
-- USERS
-- role model: every row is a "user". is_admin + permissions_json
-- control admin capabilities. is_donor toggles donor-mode features.
-- All auth (admin or donor or plain requester) shares this table.
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  mobile              TEXT NOT NULL UNIQUE,             -- 11 digit BD mobile, login identifier
  password_hash       TEXT NOT NULL,
  name                TEXT DEFAULT NULL,
  username_slug       TEXT UNIQUE DEFAULT NULL,          -- claimed or auto-generated (lowercase stored, original case in username_display)
  username_display    TEXT DEFAULT NULL,                 -- preserves user's chosen capitalization
  is_admin            INTEGER NOT NULL DEFAULT 0,        -- 0/1
  is_root_admin       INTEGER NOT NULL DEFAULT 0,        -- 0/1, single root account from CF secret
  permissions_json     TEXT DEFAULT '[]',                 -- JSON array of granular admin permission keys
  is_donor            INTEGER NOT NULL DEFAULT 0,        -- 0/1
  blood_group         TEXT DEFAULT NULL,                 -- A+, A-, B+, B-, O+, O-, AB+, AB-
  last_donation_date  TEXT DEFAULT NULL,                 -- ISO date
  donor_note          TEXT DEFAULT NULL,
  donor_note_updated_at TEXT DEFAULT NULL,
  eligibility_status   TEXT NOT NULL DEFAULT 'off',       -- 'on' | 'snoozed' | 'off'
  eligibility_snooze_until TEXT DEFAULT NULL,             -- ISO datetime, NULL = indefinite ("যতদিন না নিজে চালু করি")
  eligibility_snooze_reason TEXT DEFAULT NULL,
  next_intended_donation_date TEXT DEFAULT NULL,          -- used when admin sets wait-timeline to 0
  location_id         INTEGER DEFAULT NULL REFERENCES locations(id) ON DELETE SET NULL,
  address_summary      TEXT DEFAULT NULL,
  profile_pic_url      TEXT DEFAULT NULL,
  profile_pic_delete_url TEXT DEFAULT NULL,               -- imgbb delete url
  extra_donation_count INTEGER NOT NULL DEFAULT 0,        -- undisclosed bulk-added past donations
  total_calls_made     INTEGER NOT NULL DEFAULT 0,
  total_calls_received  INTEGER NOT NULL DEFAULT 0,
  donors_managed_count  INTEGER NOT NULL DEFAULT 0,        -- times requester successfully got blood via this account
  call_sort_rank        INTEGER NOT NULL DEFAULT 0,        -- higher = pushed later in eligible list (unresponsive penalty)
  last_served_at        TEXT DEFAULT NULL,                 -- last time shown/locked to a requester
  locked_by_requester_id INTEGER DEFAULT NULL,              -- donor is currently held for this requester's active call session
  lock_expires_at        TEXT DEFAULT NULL,                 -- mirrors the KV lock TTL; lets the eligibility query exclude locked donors cheaply
  visibility_json        TEXT DEFAULT NULL,                 -- JSON map of field -> 'public'|'patients_only'|'hidden'
  must_change_password    INTEGER NOT NULL DEFAULT 0,
  disabled               INTEGER NOT NULL DEFAULT 0,
  deleted                INTEGER NOT NULL DEFAULT 0,
  donorbd_slug_registered INTEGER NOT NULL DEFAULT 0,       -- whether current username_slug has a live donor.bd entry
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username_slug);
CREATE INDEX IF NOT EXISTS idx_users_eligibility ON users(is_donor, eligibility_status, blood_group);
CREATE INDEX IF NOT EXISTS idx_users_lock ON users(locked_by_requester_id, lock_expires_at);

-- ============================================================
-- DONATIONS (explicit, dated entries)
-- ============================================================
CREATE TABLE IF NOT EXISTS donations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hospital_name  TEXT DEFAULT NULL,
  donation_date  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_donations_user ON donations(user_id, donation_date DESC);

-- ============================================================
-- CALLS (requester -> donor contact attempts)
-- ============================================================
CREATE TABLE IF NOT EXISTS calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  donor_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blood_group    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
    -- pending | no_status | no_answer | not_picked_up | cannot_donate | can_donate
  cannot_reason  TEXT DEFAULT NULL,
    -- not_yet_eligible | far_away | busy_today | no_reason_given
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calls_requester ON calls(requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_donor ON calls(donor_id, created_at DESC);

-- ============================================================
-- LOCATIONS (admin-managed, up to 2 levels deep)
-- ============================================================
CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id  INTEGER DEFAULT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- EXTERNAL SOURCES (shown when donor list is exhausted)
-- ============================================================
CREATE TABLE IF NOT EXISTS external_sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- SETTINGS (key/value store for all admin-configurable options)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT
);

-- ============================================================
-- ACTIVITY LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS activity_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  INTEGER DEFAULT NULL,
  actor_label    TEXT DEFAULT NULL,      -- resolved display label, kept even if user later deleted
  category       TEXT NOT NULL,          -- account | settings | call | donation | admin | system
  action_text    TEXT NOT NULL,
  target_label   TEXT DEFAULT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_category ON activity_log(category);
CREATE INDEX IF NOT EXISTS idx_activity_log_actor ON activity_log(actor_user_id);

-- ============================================================
-- DEFAULT SETTINGS SEED
-- ============================================================
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_title', 'BloodNet v2'),
  ('logo_url', ''),
  ('favicon_url', ''),
  ('social_preview_url', ''),
  ('theme_color', '#c0152f'),
  ('welcome_heading', 'রক্তের প্রয়োজনে আমরা পাশে'),
  ('welcome_subheading', 'রক্তের প্রয়োজনে খুঁজে নিন ডোনারদের'),
  ('welcome_small_text', '(বর্তমানে শুধুমাত্র চট্টগ্রাম শহরের জন্য প্রযোজ্য)'),
  ('call_limit_count', '20'),
  ('call_limit_minutes', '15'),
  ('donor_lock_minutes', '15'),
  ('otp_required_for_number_change', '1'),
  ('otp_test_mode', '0'),
  ('manual_otp', ''),
  ('session_days', '90'),
  ('sms_enabled_account_created_self', '1'),
  ('sms_enabled_account_created_import', '1'),
  ('sms_enabled_otp', '1'),
  ('sms_enabled_password_reset', '1'),
  ('sms_password_reset_by_admin', 'আপনার পাসওয়ার্ড এডমিন কর্তৃক পরিবর্তন করা হয়েছে। নতুন পাসওয়ার্ড: {password}'),
  ('imgbb_api_key', ''),
  ('greensms_api_key', ''),
  ('donorbd_api_key', ''),
  ('donorbd_base_url', ''),
  ('donorbd_check_before_claim', '1'),
  ('eligibility_wait_months', '3'),
  ('self_deletion_enabled', '1'),
  ('sms_account_created_self', '{siteTitle} এ জয়েন করার জন্য ধন্যবাদ!'),
  ('sms_account_created_import', 'আপনার একটি একাউন্ট ইম্পোর্ট করা হয়েছে। পাস: {password}'),
  ('sms_otp', 'আপনার OTP: {otp}');

INSERT OR IGNORE INTO external_sources (name, url, sort_order) VALUES
  ('BloodBag', 'https://www.bloodbag.app/new-blood-request', 1);

INSERT OR IGNORE INTO locations (id, parent_id, name, sort_order) VALUES
  (1, NULL, 'চট্টগ্রাম শহর', 1);
