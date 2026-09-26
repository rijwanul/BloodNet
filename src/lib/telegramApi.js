// Thin wrapper around the raw Telegram Bot API (api.telegram.org). Every
// call is parameterized by which bot's token to use - there is no global
// bot in this app, see telegram_bots in schema (arc/migration_telegram_bot.sql)
// and the multi-bot note in the implementation plan.

async function callTelegramApi(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response - data stays null */ }
  return { httpOk: res.ok, status: res.status, data };
}

// Validates a token actually works and fetches the bot's own @username
// (needed to strip "@botusername" out of mention messages before scanning
// for a blood group - see extractBloodGroupFromText's caller in telegram.js).
export async function getMe(token) {
  const { data } = await callTelegramApi(token, "getMe", {});
  if (!data || !data.ok) throw new Error((data && data.description) || "টেলিগ্রাম টোকেন যাচাই ব্যর্থ হয়েছে - সঠিক টোকেন দিন");
  return data.result;
}

export async function setWebhook(token, url, secretToken) {
  const { data } = await callTelegramApi(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "guest_message"],
  });
  if (!data || !data.ok) throw new Error((data && data.description) || "ওয়েবহুক রেজিস্টার করা যায়নি");
  return data.result;
}

// Best-effort - called when an admin deletes/deactivates a bot so Telegram
// stops retrying delivery to a URL this app no longer intends to serve.
// Never throws: a failure here shouldn't block the bot row from being
// removed/deactivated.
export async function deleteWebhook(token) {
  try {
    await callTelegramApi(token, "deleteWebhook", {});
  } catch { /* best-effort only */ }
}

// Substrings Telegram is known to use for "this chat doesn't allow that"
// style errors. NOT verified against the live API yet (this feature is new
// as of May 2026) - match is intentionally loose/best-effort; tighten these
// once real error text has been observed from a restricted chat.
const PERMISSION_ERROR_HINTS = [
  "not enough rights",
  "have no rights",
  "forbidden",
  "restricted",
  "can't parse entities",
  "CHAT_LINKS_FORBIDDEN",
  "CHAT_INLINE_FORBIDDEN",
  "message text is empty",
];

export function isPermissionRelatedError(description) {
  const d = (description || "").toLowerCase();
  return PERMISSION_ERROR_HINTS.some((hint) => d.includes(hint.toLowerCase()));
}

// Returns { ok, result, description, errorCode, permissionError }.
export async function sendMessage(token, chatId, text, options = {}) {
  const { data } = await callTelegramApi(token, "sendMessage", { chat_id: chatId, text, ...options });
  if (data && data.ok) return { ok: true, result: data.result };
  const description = (data && data.description) || "অজানা টেলিগ্রাম এরর";
  return { ok: false, description, errorCode: data && data.error_code, permissionError: isPermissionRelatedError(description) };
}

export async function deleteMessage(token, chatId, messageId) {
  const { data } = await callTelegramApi(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
  return { ok: !!(data && data.ok), description: data && data.description };
}

// Guest Bot mode's one-shot reply (plan §3.3 / §2.2 rule feasibility note).
// Modeled on inline-query answering rather than sendMessage: a single
// InlineQueryResultArticle carrying the reply text (+ optional inline
// keyboard via reply_markup), answered against the triggering guest
// message's guest_query_id. Exactly one reply is allowed per guest_message
// per Telegram's docs, so there is no permission-error retry ladder here
// the way there is for sendMessage in §4.3 - this sends the fullest
// version of the reply (button included where applicable) in one shot.
export async function answerGuestQuery(token, guestQueryId, text, { replyMarkup, parseMode } = {}) {
  const result = {
    type: "article",
    id: String(Date.now()),
    title: "BloodNet",
    input_message_content: {
      message_text: text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  const { data } = await callTelegramApi(token, "answerGuestQuery", { guest_query_id: guestQueryId, result });
  if (data && data.ok) return { ok: true, result: data.result };
  return { ok: false, description: (data && data.description) || "অজানা টেলিগ্রাম এরর (guest query)" };
}
