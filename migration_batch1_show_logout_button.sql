-- Adds the settings key used by Batch 1's new "show logout button" admin
-- toggle. Safe to re-run - INSERT OR IGNORE skips it if already present.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('show_logout_button', '0');
