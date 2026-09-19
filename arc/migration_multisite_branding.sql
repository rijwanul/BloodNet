-- Migration: মাল্টিসাইট ব্র্যান্ডিং (multisite branding)
-- Run ONCE against the existing remote D1 database. Safe to re-run
-- (IF NOT EXISTS / INSERT OR IGNORE throughout) if it's interrupted partway.

CREATE TABLE IF NOT EXISTS multisite_brands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  domain     TEXT NOT NULL UNIQUE,
  site_title TEXT,
  logo_url   TEXT,
  favicon_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_multisite_brands_domain ON multisite_brands(domain);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('multisite_branding_enabled', '0');
