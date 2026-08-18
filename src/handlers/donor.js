import { ok, err, readJson, isValidBdMobile, nowIso } from "../lib/util.js";
import { getSettings, settingBool } from "../lib/settings.js";
import { getCurrentUser } from "../lib/authctx.js";
import { logActivity } from "../lib/activity.js";
import { checkOtp } from "./auth.js";

function requireDonor(user) {
  return user && user.is_donor && !user.deleted;
}

export async function handleDonorStatus(request, env) {
  const user = await getCurrentUser(request, env);
  if (!requireDonor(user)) return err("লগইন অথবা ডোনার একাউন্ট প্রয়োজন", 401);
  return ok({
    eligibilityStatus: user.eligibility_status,
    snoozeUntil: user.eligibility_snooze_until,
    snoozeReason: user.eligibility_snooze_reason,
    note: user.donor_note,
    lastDonationDate: user.last_donation_date,
    lastEligibilityChangeNote: user.last_eligibility_change_note,
    pendingDonationPrompt: !!user.pending_donation_prompt,
  });
}

const SNOOZE_PRESETS = {
  today: () => {
    const d = new Date();
    d.setHours(23, 59, 59, 0);
    return d;
  },
  "2h": () => new Date(Date.now() + 2 * 3600 * 1000),
  "6h": () => new Date(Date.now() + 6 * 3600 * 1000),
};

export async function handleDonorEligibility(request, env) {
  const user = await getCurrentUser(request, env);
  if (!requireDonor(user)) return err("লগইন অথবা ডোনার একাউন্ট প্রয়োজন", 401);
  const body = await readJson(request);
  const { action, snoozeType, snoozeDate } = body; // action: 'on' | 'off'

  if (action === "on") {
    await env.DB
      .prepare("UPDATE users SET eligibility_status = 'on', eligibility_snooze_until = NULL, eligibility_snooze_reason = NULL, pending_donation_prompt = 0, updated_at = ? WHERE id = ?")
      .bind(nowIso(), user.id)
      .run();
    await logActivity(env.DB, { actorUser: user, category: "settings", actionText: "নিজের এলিজিবিলিটি চালু করেছেন" });
    return ok({ status: "on" });
  }

  if (action === "off") {
    let snoozeUntil = null;
    let reasonLabel = "";
    if (snoozeType === "today_off") {
      reasonLabel = "আজকের জন্য বন্ধ";
      snoozeUntil = SNOOZE_PRESETS.today().toISOString().replace("T", " ").slice(0, 19);
      await env.DB
        .prepare("UPDATE users SET eligibility_status = 'snoozed', eligibility_snooze_until = ?, eligibility_snooze_reason = ?, updated_at = ? WHERE id = ?")
        .bind(snoozeUntil, reasonLabel, nowIso(), user.id)
        .run();
    } else if (snoozeType === "2h" || snoozeType === "6h") {
      reasonLabel = snoozeType === "2h" ? "২ঘন্টার জন্য স্থগিত" : "৬ ঘন্টার জন্য স্থগিত";
      snoozeUntil = SNOOZE_PRESETS[snoozeType]().toISOString().replace("T", " ").slice(0, 19);
      await env.DB
        .prepare("UPDATE users SET eligibility_status = 'snoozed', eligibility_snooze_until = ?, eligibility_snooze_reason = ?, updated_at = ? WHERE id = ?")
        .bind(snoozeUntil, reasonLabel, nowIso(), user.id)
        .run();
    } else if (snoozeType === "until_date") {
      if (!snoozeDate) return err("তারিখ নির্বাচন করুন");
      reasonLabel = "তারিখ পর্যন্ত স্থগিত";
      snoozeUntil = `${snoozeDate} 00:00:00`;
      await env.DB
        .prepare("UPDATE users SET eligibility_status = 'snoozed', eligibility_snooze_until = ?, eligibility_snooze_reason = ?, updated_at = ? WHERE id = ?")
        .bind(snoozeUntil, reasonLabel, nowIso(), user.id)
        .run();
    } else {
      // 'যতদিন আমি নিজে চালু না করি' - indefinite, no auto wake
      reasonLabel = "যতদিন না নিজে চালু করেন";
      await env.DB
        .prepare("UPDATE users SET eligibility_status = 'off', eligibility_snooze_until = NULL, eligibility_snooze_reason = ?, updated_at = ? WHERE id = ?")
        .bind(reasonLabel, nowIso(), user.id)
        .run();
    }
    await logActivity(env.DB, { actorUser: user, category: "settings", actionText: `নিজের এলিজিবিলিটি বন্ধ/স্থগিত করেছেন (${reasonLabel})` });
    return ok({ status: "updated" });
  }

  return err("Invalid action");
}

// "না, সম্প্রতি রক্তদান করিনি" - dismisses the pending-donation prompt
// raised after a "can_donate" call outcome, without logging an actual
// donation, and turns eligibility back on if it's currently off/snoozed
// because of that same call.
export async function handleDonorDismissDonationPrompt(request, env) {
  const user = await getCurrentUser(request, env);
  if (!requireDonor(user)) return err("লগইন অথবা ডোনার একাউন্ট প্রয়োজন", 401);
  await env.DB
    .prepare(
      "UPDATE users SET pending_donation_prompt = 0, donation_reminder_sent = 0, eligibility_status = 'on', eligibility_snooze_until = NULL, eligibility_snooze_reason = NULL, updated_at = ? WHERE id = ?"
    )
    .bind(nowIso(), user.id)
    .run();
  await logActivity(env.DB, { actorUser: user, category: "settings", actionText: "সম্প্রতি রক্তদান করেননি বলে জানিয়েছেন, এলিজিবিলিটি পুনরায় চালু করা হয়েছে" });
  return ok({ status: "on" });
}

// Lets a donor turn donor mode off entirely (distinct from pausing
// eligibility) - available from both the profile "অন্যান্য" tab and Settings.
export async function handleDonorModeOff(request, env) {
  const user = await getCurrentUser(request, env);
  if (!requireDonor(user)) return err("লগইন অথবা ডোনার একাউন্ট প্রয়োজন", 401);
  await env.DB
    .prepare("UPDATE users SET is_donor = 0, eligibility_status = 'off', eligibility_snooze_until = NULL, updated_at = ? WHERE id = ?")
    .bind(nowIso(), user.id)
    .run();
  await logActivity(env.DB, { actorUser: user, category: "account", actionText: "ডোনার মোড বন্ধ করেছেন" });
  return ok({ isDonor: false });
}

export async function handleDonorNote(request, env) {
  const user = await getCurrentUser(request, env);
  if (!requireDonor(user)) return err("লগইন অথবা ডোনার একাউন্ট প্রয়োজন", 401);
  const body = await readJson(request);
  const note = (body.note || "").slice(0, 300);
  await env.DB
    .prepare("UPDATE users SET donor_note = ?, donor_note_updated_at = ?, updated_at = ? WHERE id = ?")
    .bind(note, nowIso(), nowIso(), user.id)
    .run();
  return ok({ note });
}

export async function handleDirectDonationEntry(request, env) {
  const user = await getCurrentUser(request, env);
  if (!requireDonor(user)) return err("লগইন অথবা ডোনার একাউন্ট প্রয়োজন", 401);
  const body = await readJson(request);
  const hospitalName = body.hospitalName || null;
  const date = body.date || new Date().toISOString().slice(0, 10);
  const settings = await getSettings(env.DB);
  const waitMonths = parseInt(settings.eligibility_wait_months || "3", 10);

  await env.DB
    .prepare("INSERT INTO donations (user_id, hospital_name, donation_date, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, hospitalName, date, nowIso())
    .run();

  const until = new Date(date);
  until.setMonth(until.getMonth() + (waitMonths || 3));
  await env.DB
    .prepare(
      "UPDATE users SET last_donation_date = ?, eligibility_status = 'snoozed', eligibility_snooze_until = ?, eligibility_snooze_reason = 'সাম্প্রতিক রক্তদান', pending_donation_prompt = 0, donation_reminder_sent = 0, updated_at = ? WHERE id = ?"
    )
    .bind(date, until.toISOString().replace("T", " ").slice(0, 19), nowIso(), user.id)
    .run();

  await logActivity(env.DB, { actorUser: user, category: "donation", actionText: `রক্তদানের তথ্য যোগ করেছেন (${date})` });
  return ok({ recorded: true });
}

// Checked BEFORE sending an OTP for a mobile-number change, so a number
// that's already taken never triggers a wasted/misleading OTP send.
export async function handleDonorCheckNewMobile(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const url = new URL(request.url);
  const newMobile = (url.searchParams.get("mobile") || "").trim();
  if (!isValidBdMobile(newMobile)) return err("সঠিক মোবাইল নাম্বার দিন");
  const exists = await env.DB.prepare("SELECT id FROM users WHERE mobile = ? AND id != ? AND deleted = 0").bind(newMobile, user.id).first();
  return ok({ available: !exists });
}

export async function handleDonorChangeMobile(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const newMobile = (body.newMobile || "").trim();
  const otp = body.otp || "";
  if (!isValidBdMobile(newMobile)) return err("সঠিক মোবাইল নাম্বার দিন");

  const exists = await env.DB.prepare("SELECT id FROM users WHERE mobile = ? AND id != ? AND deleted = 0").bind(newMobile, user.id).first();
  if (exists) return err("এই মোবাইল নাম্বার ইতিমধ্যে ব্যবহৃত হচ্ছে");

  const settings = await getSettings(env.DB);
  const otpRequired = settingBool(settings, "otp_required_for_number_change", true);
  if (otpRequired) {
    const result = await checkOtp(env, settings, "change_mobile", newMobile, otp);
    if (result !== "ok") return err("OTP সঠিক নয় অথবা মেয়াদ উত্তীর্ণ");
  }

  await env.DB.prepare("UPDATE users SET mobile = ?, updated_at = ? WHERE id = ?").bind(newMobile, nowIso(), user.id).run();
  await logActivity(env.DB, { actorUser: user, category: "account", actionText: `মোবাইল নাম্বার পরিবর্তন করেছেন` });
  return ok({ mobile: newMobile });
}

export async function handleDonorChangeLocation(request, env) {
  const user = await getCurrentUser(request, env);
  if (!requireDonor(user)) return err("লগইন অথবা ডোনার একাউন্ট প্রয়োজন", 401);
  const body = await readJson(request);
  const locationId = body.locationId || null;
  const addressSummary = (body.addressSummary || "").slice(0, 200);
  await env.DB
    .prepare("UPDATE users SET location_id = ?, address_summary = ?, updated_at = ? WHERE id = ?")
    .bind(locationId, addressSummary, nowIso(), user.id)
    .run();
  await logActivity(env.DB, { actorUser: user, category: "account", actionText: "এলাকা পরিবর্তন করেছেন" });
  return ok({ updated: true });
}
