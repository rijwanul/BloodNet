-- ============================================================
-- BloodNet v2 (bnetv2) - Telegram bot integration migration
-- Run ONCE against the EXISTING remote bnetv2_db.
-- wrangler d1 execute bnetv2_db --remote --file=./arc/migration_telegram_bot.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. telegram_bots: admin-managed bot configs. Created FIRST -
--    telegram_messages.bot_id below references it.
--    Tokens/webhook secrets live here in D1 (not wrangler secret)
--    on purpose - the set of bots is admin-managed and dynamic,
--    not fixed at deploy time. See admin.js's masking of
--    bot_token in every list/get response.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_bots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  bot_token          TEXT NOT NULL,
  bot_username       TEXT,
  webhook_secret     TEXT NOT NULL,
  enabled_dm         INTEGER NOT NULL DEFAULT 1,
  enabled_groups     INTEGER NOT NULL DEFAULT 1,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- ------------------------------------------------------------
-- 2. telegram_messages: every inbound update a bot's webhook
--    processed, plus what (if anything) was replied. Shared
--    across all bots (bot_id is for display/filtering only -
--    see admin.js's handleTelegramMessagesList).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id             INTEGER REFERENCES telegram_bots(id),
  chat_id            TEXT NOT NULL,
  chat_type          TEXT NOT NULL,        -- 'private' | 'group' | 'supergroup' | 'guest'
  chat_title         TEXT,
  from_user_id       TEXT,
  from_username      TEXT,
  from_display_name  TEXT,
  trigger_type       TEXT NOT NULL,        -- 'command' | 'mention' | 'freeform' | 'guest_mention' | 'reply_fallback'
  message_text       TEXT NOT NULL,
  matched_blood_group TEXT,
  reply_tier         TEXT,                 -- see callLabels-style constants in handlers/telegram.js
  reply_text         TEXT,
  inbound_message_id TEXT NOT NULL,
  outbound_message_id TEXT,
  created_at         TEXT NOT NULL,
  deleted_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_created_at ON telegram_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat_id ON telegram_messages(chat_id);

-- ------------------------------------------------------------
-- 3. Settings: cooldown window for §3.4's per-(chat,group)
--    repeat-reply suppression in always-on freeform group mode.
--    Global across all bots, admin-tunable minutes.
-- ------------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('telegram_cooldown_minutes', '10');
