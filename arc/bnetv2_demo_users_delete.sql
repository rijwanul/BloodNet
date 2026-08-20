-- ============================================================
-- BloodNet v2 (bnetv2_db) — DEMO/TEST USER DATA (BULK DELETE)
-- Removes everything inserted by bnetv2_demo_users_insert.sql
--
-- Deletes users in the reserved demo id range. donations, calls,
-- and seek_exclusions all have ON DELETE CASCADE foreign keys to
-- users, so they clean up automatically. activity_log has NO FK
-- (by design, so labels survive real user deletion), so it is
-- deleted explicitly here by its own reserved id range.
-- ============================================================

PRAGMA foreign_keys = ON;

-- activity_log has no FK to users, so delete explicitly by id range
DELETE FROM activity_log WHERE id BETWEEN 400001 AND 400150;

-- deleting users cascades to donations, calls, seek_exclusions
DELETE FROM users WHERE id BETWEEN 100001 AND 100200;

-- ------------------------------------------------------------
-- Verification (should all return 0 after running the above)
-- ------------------------------------------------------------
-- SELECT COUNT(*) FROM users WHERE id BETWEEN 100001 AND 100200;
-- SELECT COUNT(*) FROM donations WHERE id BETWEEN 200001 AND 200287;
-- SELECT COUNT(*) FROM calls WHERE id BETWEEN 300001 AND 300260;
-- SELECT COUNT(*) FROM activity_log WHERE id BETWEEN 400001 AND 400150;
-- SELECT COUNT(*) FROM seek_exclusions WHERE requester_id BETWEEN 100001 AND 100200;
