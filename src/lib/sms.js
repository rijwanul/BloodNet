import { logActivity } from "./activity.js";
import { settingBool } from "./settings.js";

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

// Fills {placeholder} tokens in an SMS template.
export function fillTemplate(template, vars) {
  return (template || "").replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

// Generic notification SMS (account created, password reset, etc).
// `typeKey`, when provided, is checked against the admin's per-type on/off
// toggle (settings.sms_enabled_<typeKey>, default on) before sending -
// letting the admin panel turn specific SMS categories off without
// touching the GreenSMS API key itself.
export async function sendNotificationSms(db, settings, mobile, message, typeKey = null) {
  if (typeKey && !settingBool(settings, `sms_enabled_${typeKey}`, true)) {
    await logActivity(db, {
      category: "system",
      actionText: `SMS পাঠানো হয়নি (এডমিন কর্তৃক "${typeKey}" ধরনের এসএমএস বন্ধ রাখা হয়েছে): ${mobile}`,
    });
    return { sent: false, reason: "type_disabled" };
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
  const message = fillTemplate(settings.sms_otp, { otp: code });
  const result = await sendNotificationSms(db, settings, mobile, message, "otp");
  return { mode: "live", sent: result.sent };
}
