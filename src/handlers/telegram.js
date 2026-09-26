// Telegram bot integration - webhook entry point + reply logic.
// See the implementation plan this was built from for the full spec (§2-§6).
// Reuses handleSeekCount's underlying query logic (not the HTTP endpoint
// itself) and the same blood-group parsing as the web app - see
// ../lib/blood-group.js.

import { nowIso } from "../lib/util.js";
import { BLOOD_GROUPS, extractBloodGroupFromText, containsGenericBloodWord, normalizeBloodGroupToken, shortBloodGroupCode } from "../lib/blood-group.js";
import { sendMessage, answerGuestQuery } from "../lib/telegramApi.js";
import { getSettings, settingInt } from "../lib/settings.js";

// ------------------------------------------------------------------ HELPERS

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
// Local duplicate of worker.js's toBnDigits (that one isn't exported) -
// small enough that duplicating rather than threading an import through is
// the simpler tradeoff here, same as this codebase already does for a
// couple of other tiny formatting helpers.
function toBnDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => BN_DIGITS[+d]);
}

// English hh:mm am/pm + short month/day, e.g. "04:12pm, Sep 24" - matches
// the format used by the web app's share-button feature (enTimeShort in
// views-public.js) exactly, but computed correctly for a Worker: the
// browser version reads the VIEWER's local clock (naturally Bangladesh time
// for this app's users), which doesn't work server-side since the Worker
// runtime clock is UTC. This explicitly converts to Asia/Dhaka first,
// mirroring the approach worker.js's formatSeekUpdateTimestamp already
// uses for the same reason (see the plan's note on this).
function enTimeShortDhaka(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit", hour12: false, month: "short", day: "numeric",
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = parseInt(map.hour, 10);
  const ampm = hour >= 12 ? "pm" : "am";
  const h12 = hour % 12 || 12;
  return `${String(h12).padStart(2, "0")}:${map.minute}${ampm}, ${map.month} ${map.day}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Same 4-char base36 scheme the web app's share button uses for its ?i=
// cache-busting param (see views-public.js) - reused here so a bot-sent
// link behaves identically for link-preview crawlers.
function genShareId() {
  return Math.random().toString(36).slice(2, 6);
}

function baseUrl(env) {
  return (env.PUBLIC_SEEK_BASE_URL || "").replace(/\/+$/, "");
}

function buildGroupSeekUrl(env, group) {
  return `${baseUrl(env)}/seek?bg=${shortBloodGroupCode(group)}&i=${genShareId()}`;
}
function buildSummarySeekUrl(env) {
  return `${baseUrl(env)}/seek?i=${genShareId()}`;
}
function buildBareSeekUrl(env) {
  return `${baseUrl(env)}/seek`;
}
function dropIParam(url) {
  try { const u = new URL(url); u.searchParams.delete("i"); return u.href; } catch { return url; }
}
// "https://blood.iiuc.net/seek?bg=bp" -> "blood. iiuc. net/seek?bg=bp" -
// matches the plan's exact fallback format (a non-clickable de-linked
// string is never auto-fetched by a link-preview crawler, so the domain
// just needs to visually break, not encode to anything in particular).
function delinkUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.split(".").join(". ")}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

// ------------------------------------------------------------------ DATA

// Mirrors handleSeekCount's query directly (see seek.js) rather than
// calling that HTTP endpoint - a Telegram-originated request has no
// "requester" to exclude, so this is the anonymous/logged-out count.
async function getDonorCount(env, bloodGroup) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) as c FROM users WHERE is_donor = 1 AND blood_group = ? AND eligibility_status = 'on' AND deleted = 0")
    .bind(bloodGroup)
    .first();
  return row ? row.c : 0;
}

async function getExternalSources(env) {
  const { results } = await env.DB.prepare("SELECT name, url FROM external_sources ORDER BY sort_order ASC").all();
  return results;
}

// Adapts admin.js's byGroup analytics query, scoped the same way
// handleSeekCount scopes its donor pool (deleted=0, is_donor=1,
// eligibility_status='on') rather than analytics' broader "all donors"
// scope - see plan §4.1.
async function getAllGroupCounts(env) {
  const { results } = await env.DB
    .prepare("SELECT blood_group, COUNT(*) as c FROM users WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'on' AND blood_group IS NOT NULL GROUP BY blood_group")
    .all();
  const counts = {};
  for (const g of BLOOD_GROUPS) counts[g] = 0;
  for (const row of results) if (counts[row.blood_group] !== undefined) counts[row.blood_group] = row.c;
  return counts;
}

// §3.4 cooldown: suppresses a repeat freeform (unmentioned) reply for the
// same (chat, blood group) pair within the configured window. Returns true
// if it's OK to reply (and marks the cooldown), false if still cooling down.
async function checkAndSetCooldown(env, chatId, bloodGroup) {
  const settings = await getSettings(env.DB);
  const minutes = settingInt(settings, "telegram_cooldown_minutes", 10);
  const key = `tgcooldown:${chatId}:${bloodGroup}`;
  const existing = await env.KV.get(key);
  if (existing) return false;
  await env.KV.put(key, "1", { expirationTtl: Math.max(60, Math.round(minutes * 60)) });
  return true;
}

// ------------------------------------------------------------------ TEMPLATES (plan §4.2)

function templateGroupText(group, count, timeStr) {
  return `চট্টগ্রামে ${toBnDigits(count)} জন উপযুক্ত ${group} রক্তদাতা (${timeStr})`;
}

function templateSummaryText(counts, total, timeStr) {
  const breakdown = BLOOD_GROUPS.map((g) => `${g} (${counts[g] || 0})`).join(", ");
  return `চট্টগ্রামে ${toBnDigits(total)} জন উপযুক্ত রক্তদাতা।\n${breakdown}\n[${timeStr}]`;
}

function templateZeroDonorIntro(group) {
  return `দুঃখিত। বর্তমানে ${group} কোনো রক্তদাতা এভেইলেবল নেই। আপনি নিম্নোক্ত মাধ্যমসমূহে খোঁজ করতে পারেন-`;
}

// Placeholder wording per plan §4.4 - finalize with the product owner.
function templateUsageHint() {
  return 'রক্তের গ্রুপ বুঝতে পারিনি। উদাহরণ: /blood bp, /blood (সব গ্রুপের তথ্যের জন্য), অথবা "B+ লাগবে" লিখুন।';
}

// ------------------------------------------------------------------ ACTION BUILDERS
// An "action" is a plain description of what to reply with, decoupled from
// HOW it gets delivered (regular sendMessage w/ tiered fallback, vs Guest
// Bot's one-shot answerGuestQuery) - see the two deliver* functions below.

async function buildGroupAction(env, group, { addressed }) {
  const count = await getDonorCount(env, group);
  if (count === 0) {
    // Zero-donor freeform silence rule (plan §3.4): never volunteer a
    // "no donors" reply unless the bot was explicitly addressed.
    if (!addressed) return { kind: "silent", group };
    const externalSources = await getExternalSources(env);
    return { kind: "zero_donor", group, externalSources };
  }
  const timeStr = enTimeShortDhaka(new Date());
  return {
    kind: "group",
    group,
    bodyText: templateGroupText(group, count, timeStr),
    buttonLabel: `🩸 ${group} রক্তদাতাগণ`,
    url: buildGroupSeekUrl(env, group),
  };
}

async function buildSummaryAction(env) {
  const counts = await getAllGroupCounts(env);
  const total = BLOOD_GROUPS.reduce((sum, g) => sum + (counts[g] || 0), 0);
  const timeStr = enTimeShortDhaka(new Date());
  return {
    kind: "summary",
    bodyText: templateSummaryText(counts, total, timeStr),
    buttonLabel: "🩸 রক্তদাতাগণ",
    url: buildSummarySeekUrl(env),
  };
}

// Implements plan §2.2 rules 2-4 (freeform scan -> generic-word summary ->
// reply-to-parent-message fallback -> usage hint), shared by member-group
// mentions, DMs, and Guest Bot mentions alike - only what counts as
// "addressed" and whether parent-fallback is attempted differs per caller
// (see handleRegularMessage / handleGuestMessage). `via` on the return
// value tells the caller whether the match came from the message itself or
// from the parent it was replying to, purely for the trigger_type log column.
async function resolveFreeformOrMention(env, { text, addressed, parentText, allowParentFallback }) {
  const group = extractBloodGroupFromText(text);
  if (group) return { action: await buildGroupAction(env, group, { addressed }), via: "direct" };

  if (addressed && containsGenericBloodWord(text)) {
    return { action: await buildSummaryAction(env), via: "direct" };
  }
  if (!addressed) {
    // §3.2's own carve-out: unmentioned freeform NEVER falls through to the
    // generic-word summary, and a total miss is silent, not a usage hint.
    return { action: { kind: "silent" }, via: "direct" };
  }
  if (allowParentFallback && parentText) {
    const parentGroup = extractBloodGroupFromText(parentText);
    if (parentGroup) return { action: await buildGroupAction(env, parentGroup, { addressed: true }), via: "parent" };
    if (containsGenericBloodWord(parentText)) return { action: await buildSummaryAction(env), via: "parent" };
  }
  return { action: { kind: "usage_hint" }, via: "direct" };
}

// ------------------------------------------------------------------ DELIVERY (plan §4.3)

// Regular sendMessage delivery for templates (a)/(b) with the tiered
// button -> plain-URL -> de-linked-URL fallback. Only retries on a
// permission-related failure (see isPermissionRelatedError in
// lib/telegramApi.js) - any other error (network, blocked, rate limit)
// stops immediately per plan §4.3's error-handling nuance.
async function sendGroupOrSummaryReply(bot, chatId, replyToMessageId, { bodyText, buttonLabel, url }) {
  let res = await sendMessage(bot.bot_token, chatId, bodyText, {
    reply_to_message_id: replyToMessageId,
    reply_markup: { inline_keyboard: [[{ text: buttonLabel, url }]] },
  });
  if (res.ok) return { tier: "button", replyText: bodyText, messageId: res.result.message_id };
  if (!res.permissionError) return { tier: null, replyText: null, messageId: null };

  const plainText = `${url}\n${bodyText}`;
  res = await sendMessage(bot.bot_token, chatId, plainText, { reply_to_message_id: replyToMessageId });
  if (res.ok) return { tier: "plain_url", replyText: plainText, messageId: res.result.message_id };
  if (!res.permissionError) return { tier: null, replyText: null, messageId: null };

  const delinkedText = `${delinkUrl(dropIParam(url))}\n${bodyText}`;
  res = await sendMessage(bot.bot_token, chatId, delinkedText, { reply_to_message_id: replyToMessageId });
  if (res.ok) return { tier: "delinked_url", replyText: delinkedText, messageId: res.result.message_id };
  return { tier: null, replyText: null, messageId: null };
}

// Template (c) - zero donors, never a button, per plan §4.3.
async function sendZeroDonorReply(env, bot, chatId, replyToMessageId, group, externalSources) {
  const intro = templateZeroDonorIntro(group);
  if (externalSources && externalSources.length) {
    const links = externalSources.map((s) => `<a href="${escapeHtml(s.url)}">${escapeHtml(s.name)}</a>`).join("\n");
    const text = `${intro}\n${links}`;
    const res = await sendMessage(bot.bot_token, chatId, text, { reply_to_message_id: replyToMessageId, parse_mode: "HTML" });
    if (res.ok) return { tier: "links", replyText: text, messageId: res.result.message_id };
    if (!res.permissionError) return { tier: null, replyText: null, messageId: null };
  }
  const fallbackText = `${intro}\n${delinkUrl(buildBareSeekUrl(env))}`;
  const res2 = await sendMessage(bot.bot_token, chatId, fallbackText, { reply_to_message_id: replyToMessageId });
  if (res2.ok) return { tier: "delinked", replyText: fallbackText, messageId: res2.result.message_id };
  return { tier: null, replyText: null, messageId: null };
}

async function sendUsageHint(bot, chatId, replyToMessageId) {
  const text = templateUsageHint();
  const res = await sendMessage(bot.bot_token, chatId, text, { reply_to_message_id: replyToMessageId });
  return res.ok ? { replyText: text, messageId: res.result.message_id } : { replyText: null, messageId: null };
}

// ------------------------------------------------------------------ LOGGING (plan §5)

async function logTelegramMessage(env, f) {
  await env.DB
    .prepare(
      `INSERT INTO telegram_messages
        (bot_id, chat_id, chat_type, chat_title, from_user_id, from_username, from_display_name, trigger_type,
         message_text, matched_blood_group, reply_tier, reply_text, inbound_message_id, outbound_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      f.botId, String(f.chatId), f.chatType, f.chatTitle || null,
      f.fromUserId != null ? String(f.fromUserId) : null, f.fromUsername || null, f.fromDisplayName || null,
      f.triggerType, f.messageText, f.matchedBloodGroup || null, f.replyTier || "none", f.replyText || null,
      f.inboundMessageId != null ? String(f.inboundMessageId) : null, f.outboundMessageId != null ? String(f.outboundMessageId) : null,
      nowIso()
    )
    .run();
}

// Dispatches a resolved action to the regular sendMessage delivery path,
// applies the §3.4 cooldown where applicable, and logs the result.
async function deliverAndLog(env, bot, action, meta) {
  let replyTier = "none";
  let replyText = null;
  let outboundMessageId = null;
  let suppressed = false;

  if (action.kind === "group" && meta.applyCooldown) {
    const allowed = await checkAndSetCooldown(env, meta.chatId, action.group);
    if (!allowed) suppressed = true;
  }

  if (!suppressed) {
    if (action.kind === "group" || action.kind === "summary") {
      const r = await sendGroupOrSummaryReply(bot, meta.chatId, meta.replyToMessageId, action);
      if (r.tier) { replyTier = `${action.kind === "group" ? "group" : "summary"}_${r.tier}`; replyText = r.replyText; outboundMessageId = r.messageId; }
    } else if (action.kind === "zero_donor") {
      const r = await sendZeroDonorReply(env, bot, meta.chatId, meta.replyToMessageId, action.group, action.externalSources);
      if (r.tier) { replyTier = `zero_donor_${r.tier}`; replyText = r.replyText; outboundMessageId = r.messageId; }
    } else if (action.kind === "usage_hint") {
      const r = await sendUsageHint(bot, meta.chatId, meta.replyToMessageId);
      if (r.replyText) { replyTier = "usage_hint"; replyText = r.replyText; outboundMessageId = r.messageId; }
    }
    // "silent" / "none" -> nothing sent, replyTier stays "none".
  }

  await logTelegramMessage(env, {
    botId: bot.id, chatId: meta.chatId, chatType: meta.chatType, chatTitle: meta.chatTitle,
    fromUserId: meta.fromUserId, fromUsername: meta.fromUsername, fromDisplayName: meta.fromDisplayName,
    triggerType: meta.triggerType, messageText: meta.messageText,
    matchedBloodGroup: action.group || null, replyTier, replyText,
    inboundMessageId: meta.inboundMessageId, outboundMessageId,
  });
}

// Guest Bot mode's one-shot answerGuestQuery delivery - no permission-error
// fallback ladder (see lib/telegramApi.js's answerGuestQuery comment), so
// the fullest version of the reply (button included) is sent directly.
async function deliverAndLogGuest(env, bot, action, meta) {
  let replyTier = "none";
  let replyText = null;
  let outboundMessageId = null;

  if (action.kind === "group" || action.kind === "summary") {
    replyText = action.bodyText;
    const r = await answerGuestQuery(bot.bot_token, meta.guestQueryId, action.bodyText, {
      replyMarkup: { inline_keyboard: [[{ text: action.buttonLabel, url: action.url }]] },
    });
    if (r.ok) { replyTier = `${action.kind === "group" ? "group" : "summary"}_button`; outboundMessageId = (r.result && (r.result.message_id || r.result.id)) || null; }
  } else if (action.kind === "zero_donor") {
    const links = (action.externalSources || []).map((s) => `${s.name}: ${s.url}`).join("\n");
    replyText = `${templateZeroDonorIntro(action.group)}\n${links}`;
    const r = await answerGuestQuery(bot.bot_token, meta.guestQueryId, replyText, {});
    if (r.ok) { replyTier = "zero_donor_links"; outboundMessageId = (r.result && (r.result.message_id || r.result.id)) || null; }
  } else if (action.kind === "usage_hint") {
    replyText = templateUsageHint();
    const r = await answerGuestQuery(bot.bot_token, meta.guestQueryId, replyText, {});
    if (r.ok) { replyTier = "usage_hint"; outboundMessageId = (r.result && (r.result.message_id || r.result.id)) || null; }
  }
  // action.kind is never "silent"/"none" here - Guest Bot mentions are
  // always addressed=true, so buildGroupAction/resolveFreeformOrMention
  // never take the silent branch for them.

  await logTelegramMessage(env, {
    botId: bot.id, chatId: meta.chatId, chatType: meta.chatType, chatTitle: meta.chatTitle,
    fromUserId: meta.fromUserId, fromUsername: meta.fromUsername, fromDisplayName: meta.fromDisplayName,
    triggerType: meta.triggerType, messageText: meta.messageText,
    matchedBloodGroup: action.group || null, replyTier, replyText,
    inboundMessageId: meta.inboundMessageId, outboundMessageId,
  });
}

// ------------------------------------------------------------------ PER-CONTEXT HANDLERS (plan §3)

async function handleRegularMessage(env, bot, message) {
  const chat = message.chat || {};
  const chatType = chat.type;
  if (chatType === "channel") return; // out of scope - only private/group/supergroup
  const isPrivate = chatType === "private";

  // §6.2/§6.5 - a disabled toggle still 200-acks (caller does that) but
  // does no processing or logging at all.
  if (isPrivate && !bot.enabled_dm) return;
  if (!isPrivate && !bot.enabled_groups) return;

  const text = message.text || message.caption || "";
  const botUsername = bot.bot_username || "";
  const mentionToken = botUsername ? `@${botUsername}` : null;
  const isMentioned = !!(mentionToken && text.toLowerCase().includes(mentionToken.toLowerCase()));
  const strippedText = mentionToken ? text.replace(new RegExp(escapeRegExp(mentionToken), "gi"), " ").trim() : text.trim();

  const commandMatch = strippedText.match(/^\/blood(?:@\S+)?(?:\s+(\S+))?/i);
  const parentText = (message.reply_to_message && (message.reply_to_message.text || message.reply_to_message.caption)) || null;
  // §3.1 (DM) / §3.2 (member group, mentioned or /blood) - a DM or a
  // mention/command always counts as "explicitly addressed"; unmentioned
  // freeform text in a group does not (see resolveFreeformOrMention's own
  // carve-out for that case).
  const addressed = isPrivate || isMentioned || !!commandMatch;

  let triggerType;
  let action;

  if (commandMatch) {
    triggerType = "command";
    const arg = commandMatch[1] || null;
    if (!arg) {
      action = await buildSummaryAction(env); // bare /blood -> all-groups summary (plan §2.2 rule 1)
    } else {
      const group = normalizeBloodGroupToken(arg);
      action = group ? await buildGroupAction(env, group, { addressed: true }) : { kind: "usage_hint" };
    }
  } else {
    const { action: resolved, via } = await resolveFreeformOrMention(env, {
      text: strippedText,
      addressed,
      parentText,
      allowParentFallback: addressed, // rule 4 only matters once addressed
    });
    action = resolved;
    triggerType = via === "parent" ? "reply_fallback" : (isPrivate ? "freeform" : (isMentioned ? "mention" : "freeform"));
  }

  await deliverAndLog(env, bot, action, {
    chatId: chat.id, chatType, chatTitle: chat.title || null,
    fromUserId: message.from && message.from.id,
    fromUsername: message.from && message.from.username,
    fromDisplayName: message.from ? [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") : null,
    triggerType, messageText: text,
    inboundMessageId: message.message_id, replyToMessageId: message.message_id,
    // Only the §3.2 always-on freeform (unaddressed) case gets rate-limited -
    // a command, mention, or DM is a deliberate ask and should never be
    // silently dropped for cooldown.
    applyCooldown: !addressed,
  });
}

async function handleGuestMessage(env, bot, guestMessage) {
  // guest_message is a full Message object (see Bot API 10.0's guest mode
  // addition) - guest_bot_caller_chat/guest_bot_caller_user are the more
  // reliable fields for "where/who summoned this", falling back to the
  // ordinary chat/from fields if those aren't present.
  const chat = guestMessage.guest_bot_caller_chat || guestMessage.chat || {};
  if (chat.type === "private" ? !bot.enabled_dm : !bot.enabled_groups) return;

  const text = guestMessage.text || guestMessage.caption || "";
  const botUsername = bot.bot_username || "";
  const mentionToken = botUsername ? `@${botUsername}` : null;
  const strippedText = mentionToken ? text.replace(new RegExp(escapeRegExp(mentionToken), "gi"), " ").trim() : text.trim();
  const parentText = (guestMessage.reply_to_message && (guestMessage.reply_to_message.text || guestMessage.reply_to_message.caption)) || null;

  // A Guest Bot mention is, by definition, always an explicit summon - see
  // plan §3.3 ("always addressed"). Per Telegram's own docs the summoning
  // update DOES include reply_to_message content when present, so rule 4's
  // parent-fallback is attempted here too (not scoped out, per direction to
  // follow current Bot API docs rather than the plan's original caution).
  const { action, via } = await resolveFreeformOrMention(env, { text: strippedText, addressed: true, parentText, allowParentFallback: true });
  const triggerType = via === "parent" ? "reply_fallback" : "guest_mention";

  const fromUser = guestMessage.guest_bot_caller_user || guestMessage.from || {};
  await deliverAndLogGuest(env, bot, action, {
    chatId: chat.id, chatType: "guest", chatTitle: chat.title || null,
    fromUserId: fromUser.id, fromUsername: fromUser.username,
    fromDisplayName: fromUser.first_name ? [fromUser.first_name, fromUser.last_name].filter(Boolean).join(" ") : null,
    triggerType, messageText: text,
    inboundMessageId: guestMessage.message_id, guestQueryId: guestMessage.guest_query_id,
  });
}

// ------------------------------------------------------------------ WEBHOOK ENTRY POINT (plan §6.5)

export async function handleTelegramWebhook(request, env, botIdParam) {
  const botId = parseInt(botIdParam, 10);
  if (!Number.isFinite(botId)) return new Response(null, { status: 200 });

  const bot = await env.DB.prepare("SELECT * FROM telegram_bots WHERE id = ?").bind(botId).first();
  // Unknown or deactivated bot: 200 with no processing - an error here
  // would make Telegram retry indefinitely against a deliberately-off bot.
  if (!bot || !bot.is_active) return new Response(null, { status: 200 });

  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secretHeader !== bot.webhook_secret) return new Response(null, { status: 401 });

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response(null, { status: 200 });
  }

  const message = update.message;
  const guestMessage = update.guest_message;
  if (!message && !guestMessage) return new Response(null, { status: 200 }); // other update types (callback_query, etc.) are out of scope

  try {
    if (guestMessage) await handleGuestMessage(env, bot, guestMessage);
    else await handleRegularMessage(env, bot, message);
  } catch {
    // Swallow processing errors rather than surfacing a 5xx - Telegram would
    // otherwise retry the same update; better to skip this one and keep
    // working for the next. Build defensively per plan §8 (Guest Mode in
    // particular is very new and may return under-documented shapes).
  }

  return new Response(null, { status: 200 });
}
