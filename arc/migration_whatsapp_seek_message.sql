-- Migration: adds the admin-configurable WhatsApp message used by the new
-- "হোয়াটসঅ্যাপে ওপেন করুন" button on the seek page.
-- Safe to re-run on its own - INSERT OR IGNORE skips existing keys.
-- wrangler d1 execute bnetv2_db --remote --file=./migration_whatsapp_seek_message.sql

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('whatsapp_seek_message', 'আসসালামুআলাইকুম। আশা করি ভালো আছেন। {bloodGroup} রক্তদাতা খুঁজছিলাম। আপনি কি এভেইলেবল আছেন?');
