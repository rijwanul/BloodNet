import { logActivity } from "./activity.js";
import { settingBool, settingInt } from "./settings.js";

// Which SMS types count as "user-initiated" (the recipient's own action
// triggered it - they typed their number and asked for something) vs
// "system" (triggered by someone/something else - an admin, another
// user's call, or automation). Two separate daily caps apply per spec.
const USER_INITIATED_TYPES = new Set(["otp", "account_created_self"]);
// Everything else (account_created_import, password_reset_by_admin,
// eligibility_change_by_call, donation_reminder, or no typeKey at all) is
// treated as "system" by default.

function todayIsoDate() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Sends a plain SMS via the configured bulk-SMS gateway (bdbulksms.net /
// GreenSMS-compatible token API). Uses multipart FormData with fields:
// token, message, to - matching the provider's documented JS example.
//
// The gateway returns JSON: a single object for one recipient, or an array
// of objects when sending to multiple numbers. Each object looks like:
//   { "to": "+8801xxxxxxx", "message": "...", "status": "SENT", "statusmsg": "..." }
//   { "to": "+8801xxxxxxx", "message": "...", "status": "FAILED", "statusmsg": "..." }
async function sendViaGreenSms(apiKey, mobile, message) {
  const form = new FormData();
  form.set("token", apiKey);
  form.set("message", message);
  form.set("to", mobile);
  const res = await fetch("https://api.bdbulksms.net/api.php?json", {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SMS পাঠাতে ব্যর্থ (${res.status}): ${text}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`অজানা রেসপন্স: ${text}`);
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const success = entries.some((e) => String(e.status || "").toUpperCase() === "SENT");
  const failedMsgs = entries.filter((e) => String(e.status || "").toUpperCase() !== "SENT").map((e) => e.statusmsg || e.status);

  if (!success) {
    throw new Error(failedMsgs.length ? failedMsgs.join(" | ") : `অজানা রেসপন্স: ${text}`);
  }
  return { raw: text, entries };
}

// Fills {placeholder} tokens in an SMS template. siteTitle is ALWAYS
// available regardless of what the caller passes (individual call sites
// used to forget to include it, which is why {siteTitle} sometimes showed
// up literally in sent messages) - explicit vars still win if a caller
// deliberately overrides it.
export function fillTemplate(template, vars, settings = null) {
  const merged = settings ? { siteTitle: settings.site_title || "", ...vars } : vars;
  return (template || "").replace(/\{(\w+)\}/g, (_, k) => (k in merged ? merged[k] : `{${k}}`));
}

// Checks the recipient's daily SMS cap (user-initiated or system,
// whichever `typeKey` maps to) and, if under the limit, atomically bumps
// the counter and returns {allowed:true}. If the stored counters are from
// a previous day (sms_count_date != today), they're lazily reset to 0
// first - this is a safety net alongside the scheduled daily reset job, so
// a request arriving right at midnight or if the scheduled job is ever
// delayed doesn't undercount against yesterday's totals.
// Also updates the recipient's highest-single-day-SMS record when this
// send makes their running today's-total exceed it.
async function checkAndBumpSmsLimit(db, settings, mobile, typeKey) {
  const isUserInitiated = typeKey && USER_INITIATED_TYPES.has(typeKey);
  const limitKey = isUserInitiated ? "sms_daily_limit_user_initiated" : "sms_daily_limit_system";
  const countCol = isUserInitiated ? "sms_user_initiated_count" : "sms_system_count";
  const overrideCol = isUserInitiated ? "sms_user_initiated_limit_override" : "sms_system_limit_override";
  const limit = settingInt(settings, limitKey, 3);
  const today = todayIsoDate();

  const user = await db.prepare(`SELECT id, ${countCol} as cnt, sms_count_date, ${overrideCol} as override_limit FROM users WHERE mobile = ?`).bind(mobile).first();
  if (!user) return { allowed: true, isUserInitiated }; // not a registered user (e.g. a number typed into a form pre-signup) - no cap applies

  const currentCount = user.sms_count_date === today ? user.cnt : 0;
  const effectiveLimit = Number.isFinite(user.override_limit) && user.override_limit !== null ? user.override_limit : limit;

  if (currentCount >= effectiveLimit) {
    return { allowed: false, isUserInitiated };
  }

  const otherCol = isUserInitiated ? "sms_system_count" : "sms_user_initiated_count";
  if (user.sms_count_date !== today) {
    // Date rolled over - reset BOTH counters together so they stay in sync
    // with sms_count_date, not just the one being incremented.
    await db.prepare(`UPDATE users SET ${countCol} = 1, ${otherCol} = 0, sms_count_date = ? WHERE id = ?`).bind(today, user.id).run();
  } else {
    await db.prepare(`UPDATE users SET ${countCol} = ${countCol} + 1 WHERE id = ?`).bind(user.id).run();
  }

  // Highest-daily-count tracking: today's combined (user-initiated +
  // system) total, compared against this number's all-time record.
  const fresh = await db.prepare("SELECT sms_user_initiated_count, sms_system_count, sms_highest_daily_count FROM users WHERE id = ?").bind(user.id).first();
  const total = fresh.sms_user_initiated_count + fresh.sms_system_count;
  if (total > fresh.sms_highest_daily_count) {
    await db.prepare("UPDATE users SET sms_highest_daily_count = ?, sms_highest_daily_date = ? WHERE id = ?").bind(total, today, user.id).run();
  }

  return { allowed: true, isUserInitiated };
}

// Generic notification SMS (account created, password reset, etc).
// `typeKey`, when provided, is checked against the admin's per-type on/off
// toggle (settings.sms_enabled_<typeKey>, default on) before sending -
// letting the admin panel turn specific SMS categories off without
// touching the GreenSMS API key itself. Every outcome (sent, skipped
// because the type is off, skipped because no API key is set, or failed)
// is logged to the Activity Log, per spec "All SMS should be logged".
export async function sendNotificationSms(db, settings, mobile, message, typeKey = null) {
  if (typeKey && !settingBool(settings, `sms_enabled_${typeKey}`, true)) {
    await logActivity(db, {
      category: "system",
      actionText: `SMS পাঠানো হয়নি (এডমিন কর্তৃক "${typeKey}" ধরনের এসএমএস বন্ধ রাখা হয়েছে): ${mobile}`,
    });
    return { sent: false, reason: "type_disabled" };
  }

  // Daily SMS cap - checked BEFORE actually sending, so a number that's
  // already at its limit never gets another message regardless of how
  // many different features try to notify it in the same day.
  const limitCheck = await checkAndBumpSmsLimit(db, settings, mobile, typeKey);
  if (!limitCheck.allowed) {
    await logActivity(db, {
      category: "sms over limit",
      actionText: `SMS পাঠানো হয়নি (দৈনিক ${limitCheck.isUserInitiated ? "ইউজার-উদ্যোগী" : "সিস্টেম"} লিমিট শেষ): ${mobile}`,
    });
    return { sent: false, reason: "over_limit" };
  }

  const apiKey = settings.greensms_api_key;
  if (!apiKey) {
    await logActivity(db, {
      category: "system",
      actionText: `SMS পাঠানো যায়নি (GreenSMS API Key সেট করা নেই): ${mobile}`,
    });
    return { sent: false, reason: "no_api_key" };
  }
  try {
    const result = await sendViaGreenSms(apiKey, mobile, message);
    await logActivity(db, {
      category: "system",
      actionText: `SMS পাঠানো হয়েছে${typeKey ? ` (${typeKey})` : ""}: ${mobile}`,
    });
    return { sent: true, raw: result.raw };
  } catch (e) {
    const detail = String(e.message || e);
    await logActivity(db, {
      category: "system",
      actionText: `SMS পাঠাতে ব্যর্থ: ${mobile} - ${detail}`,
    });
    return { sent: false, reason: detail };
  }
}

// OTP-specific send flow implementing the admin-configurable behaviour:
//  1) Manual OTP set (settings.manual_otp non-empty) -> that fixed code is
//     valid everywhere; nothing is actually sent, nothing is logged.
//  2) Manual OTP empty + Test Mode on -> a random OTP is generated and
//     stored, but instead of sending real SMS it is written to the
//     Activity Log so admins/testers can read it.
//  3) Manual OTP empty + Test Mode off -> real OTP generated, stored, and
//     sent via GreenSMS using the configured sms_otp template (subject to
//     the sms_enabled_otp on/off toggle).
// Returns { mode, code } - code is null when a real SMS was dispatched
// (caller should NOT reveal it), and non-null in manual/test modes only
// for internal bookkeeping (still never returned to the client response).
export async function dispatchOtp(db, settings, mobile, code) {
  const manual = (settings.manual_otp || "").trim();
  if (manual) {
    return { mode: "manual" }; // verification will compare against settings.manual_otp directly
  }
  const testMode = settings.otp_test_mode === "1" || settings.otp_test_mode === "true";
  if (testMode) {
    await logActivity(db, {
      category: "system",
      actionText: `[OTP টেস্ট মোড] ${mobile} এর জন্য OTP: ${code}`,
    });
    return { mode: "test" };
  }
  const message = fillTemplate(settings.sms_otp, { otp: code }, settings);
  const result = await sendNotificationSms(db, settings, mobile, message, "otp");
  if (result.reason === "over_limit") {
    // Distinct from a generic send failure - the frontend shows the
    // admin-configurable "call us" message under the OTP input for this
    // case specifically, rather than a plain "couldn't send OTP" error.
    return { mode: "live", sent: false, overLimit: true, overLimitMessage: settings.sms_over_limit_otp_message || "আপনার দৈনিক এসএমএস লিমিট শেষ হয়েছে। 01883-600680 নাম্বারে কল করুন" };
  }
  return { mode: "live", sent: result.sent };
}
