import { ok, err, readJson, isValidBloodGroup, nowIso, maskMobile } from "../lib/util.js";
import { getSettings, settingInt } from "../lib/settings.js";
import { getCurrentUser, publicUserFields } from "../lib/authctx.js";
import { getLock, setLock, clearLock, checkAndBumpRateLimit } from "../lib/kvstore.js";
import { logActivity } from "../lib/activity.js";

async function wakeSnoozedDonors(db) {
  await db
    .prepare(
      "UPDATE users SET eligibility_status = 'on', eligibility_snooze_until = NULL, eligibility_snooze_reason = NULL WHERE is_donor = 1 AND eligibility_status = 'snoozed' AND eligibility_snooze_until IS NOT NULL AND eligibility_snooze_until <= datetime('now')"
    )
    .run();
}

async function releaseExpiredLocks(db) {
  await db
    .prepare("UPDATE users SET locked_by_requester_id = NULL, lock_expires_at = NULL WHERE lock_expires_at IS NOT NULL AND lock_expires_at <= datetime('now')")
    .run();
}

export async function handleSeekCount(request, env) {
  await wakeSnoozedDonors(env.DB);
  const url = new URL(request.url);
  const bloodGroup = url.searchParams.get("bloodGroup");
  if (!isValidBloodGroup(bloodGroup)) return err("সঠিক রক্তের গ্রুপ দিন");
  const row = await env.DB
    .prepare("SELECT COUNT(*) as c FROM users WHERE is_donor = 1 AND blood_group = ? AND eligibility_status = 'on' AND deleted = 0")
    .bind(bloodGroup)
    .first();
  return ok({ count: row.c });
}

function donorPublicShape(d) {
  const vis = safeJson(d.visibility_json) || {};
  const isVisible = (field, def) => (vis[field] || def) !== "hidden";
  return {
    id: d.id,
    name: d.name || "নাম প্রদান করেননি",
    username: d.username_display,
    profilePicUrl: d.profile_pic_url,
    bloodGroup: d.blood_group,
    totalDonations: (d.extra_donation_count || 0) + (d.explicit_donation_count || 0),
    addressSummary: isVisible("address_summary", "patients_only") ? d.address_summary : null,
    lastDonationDate: isVisible("last_donation_date", "patients_only") ? d.last_donation_date : null,
    note: d.donor_note || null,
    mobileMasked: maskMobile(d.mobile),
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

export async function handleSeekLock(request, env) {
  const requester = await getCurrentUser(request, env);
  if (!requester) return err("রক্তদাতা খুঁজতে লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const bloodGroup = body.bloodGroup;
  if (!isValidBloodGroup(bloodGroup)) return err("সঠিক রক্তের গ্রুপ দিন");

  const settings = await getSettings(env.DB);
  await wakeSnoozedDonors(env.DB);
  await releaseExpiredLocks(env.DB);

  // Re-serve the same donor if this requester already has an active lock.
  const existingLock = await getLock(env.KV, requester.id);
  if (existingLock) {
    const donor = await env.DB
      .prepare("SELECT u.*, (SELECT COUNT(*) FROM donations WHERE user_id = u.id) as explicit_donation_count FROM users u WHERE id = ? AND deleted = 0")
      .bind(existingLock.donorId)
      .first();
    if (donor) return ok({ donor: donorPublicShape(donor) });
    await clearLock(env.KV, requester.id);
  }

  const limitCount = settingInt(settings, "call_limit_count", 20);
  const limitMinutes = settingInt(settings, "call_limit_minutes", 15);
  const rate = await checkAndBumpRateLimit(env.KV, requester.id, limitCount, limitMinutes);
  if (!rate.allowed) {
    return err(
      `আপনার লিমিট শেষ হয়েছে। আপনি ${limitMinutes} মিনিট এর মধ্যে সর্বোচ্চ ${limitCount} জন ডোনারের সাথে যোগাযোগ করতে পারবেন। অনুগ্রহ করে অপেক্ষা করুন।`,
      429,
      { retryAfterSeconds: rate.retryAfterSeconds }
    );
  }

  const donor = await env.DB
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM donations WHERE user_id = u.id) as explicit_donation_count
       FROM users u
       WHERE is_donor = 1 AND blood_group = ? AND eligibility_status = 'on' AND deleted = 0
         AND id != ?
         AND (locked_by_requester_id IS NULL OR lock_expires_at <= datetime('now'))
       ORDER BY call_sort_rank ASC, total_calls_received ASC, id ASC
       LIMIT 1`
    )
    .bind(bloodGroup, requester.id)
    .first();

  if (!donor) {
    const { results: sources } = await env.DB.prepare("SELECT name, url FROM external_sources ORDER BY sort_order ASC").all();
    return ok({ donor: null, externalSources: sources });
  }

  const lockMinutes = settingInt(settings, "donor_lock_minutes", 15);
  const lockExpiresAt = new Date(Date.now() + lockMinutes * 60000).toISOString().replace("T", " ").slice(0, 19);
  await env.DB
    .prepare("UPDATE users SET locked_by_requester_id = ?, lock_expires_at = ? WHERE id = ?")
    .bind(requester.id, lockExpiresAt, donor.id)
    .run();
  await setLock(env.KV, requester.id, donor.id, lockMinutes);

  return ok({ donor: donorPublicShape(donor) });
}

const CANNOT_REASON_LABELS = {
  not_yet_eligible: "রক্ত দেওয়ার সময় হয়নি",
  far_away: "দূরে আছেন",
  busy_today: "আজকে ব্যস্ত",
  no_reason_given: "কারণ জানান নি",
};

export async function handleSeekCallStatus(request, env) {
  const requester = await getCurrentUser(request, env);
  if (!requester) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const { donorId, status, cannotReason } = body;
  const donor = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").bind(donorId).first();
  if (!donor) return err("ডোনার পাওয়া যায়নি");

  const settings = await getSettings(env.DB);
  const waitMonths = settingInt(settings, "eligibility_wait_months", 3);

  await env.DB
    .prepare(
      "INSERT INTO calls (requester_id, donor_id, blood_group, status, cannot_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(requester.id, donor.id, donor.blood_group, status, cannotReason || null, nowIso(), nowIso())
    .run();

  await env.DB.prepare("UPDATE users SET total_calls_made = total_calls_made + 1 WHERE id = ?").bind(requester.id).run();
  await env.DB.prepare("UPDATE users SET total_calls_received = total_calls_received + 1 WHERE id = ?").bind(donor.id).run();

  if (status === "no_answer" || status === "not_picked_up") {
    // Push to bottom of the eligible list instead of disturbing them again soon.
    await env.DB.prepare("UPDATE users SET call_sort_rank = ? WHERE id = ?").bind(Date.now(), donor.id).run();
  } else if (status === "cannot_donate") {
    if (cannotReason === "not_yet_eligible") {
      await env.DB.prepare("UPDATE users SET eligibility_status = 'off' WHERE id = ?").bind(donor.id).run();
    } else {
      // far_away / busy_today / no_reason_given -> snoozed for the rest of the day
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 0);
      await env.DB
        .prepare("UPDATE users SET eligibility_status = 'snoozed', eligibility_snooze_until = ?, eligibility_snooze_reason = ? WHERE id = ?")
        .bind(endOfDay.toISOString().replace("T", " ").slice(0, 19), CANNOT_REASON_LABELS[cannotReason] || cannotReason, donor.id)
        .run();
    }
  } else if (status === "can_donate") {
    await env.DB.prepare("UPDATE users SET donors_managed_count = donors_managed_count + 1 WHERE id = ?").bind(requester.id).run();
    // Successful donation expected soon: snooze per admin wait timeline, or await manual date entry if 0.
    if (waitMonths > 0) {
      const until = new Date();
      until.setMonth(until.getMonth() + waitMonths);
      await env.DB
        .prepare("UPDATE users SET eligibility_status = 'snoozed', eligibility_snooze_until = ?, last_donation_date = date('now') WHERE id = ?")
        .bind(until.toISOString().replace("T", " ").slice(0, 19), donor.id)
        .run();
    } else {
      await env.DB.prepare("UPDATE users SET eligibility_status = 'off' WHERE id = ?").bind(donor.id).run();
    }
  }

  // Release the lock only for terminal outcomes; no_answer/not_picked_up frees it too (requester should move on).
  await env.DB.prepare("UPDATE users SET locked_by_requester_id = NULL, lock_expires_at = NULL WHERE id = ?").bind(donor.id).run();
  const { clearLock } = await import("../lib/kvstore.js");
  await clearLock(env.KV, requester.id);

  await logActivity(env.DB, {
    actorUser: requester,
    category: "call",
    actionText: `${requester.mobile} → ${donor.mobile} কল করেছিলেন। ষ্ট্যাটাস: ${status}${cannotReason ? " (" + (CANNOT_REASON_LABELS[cannotReason] || cannotReason) + ")" : ""}`,
  });

  return ok({ recorded: true });
}

export async function handleSeekDonorNumber(request, env) {
  const requester = await getCurrentUser(request, env);
  if (!requester) return err("লগইন প্রয়োজন", 401);
  const url = new URL(request.url);
  const donorId = parseInt(url.searchParams.get("donorId"), 10);
  if (!donorId) return err("সঠিক ডোনার আইডি দিন");

  // Only reveal the real number if this donor is actually currently locked
  // to this requester - prevents scraping numbers by guessing donor ids.
  const lock = await getLock(env.KV, requester.id);
  if (!lock || lock.donorId !== donorId) {
    return err("এই ডোনারের সাথে আপনার কোনো সক্রিয় লক নেই", 403);
  }

  const donor = await env.DB.prepare("SELECT mobile FROM users WHERE id = ? AND deleted = 0").bind(donorId).first();
  if (!donor) return err("ডোনার পাওয়া যায়নি", 404);
  return ok({ mobile: donor.mobile });
}

export async function handleExternalSources(request, env) {
  const { results } = await env.DB.prepare("SELECT name, url FROM external_sources ORDER BY sort_order ASC").all();
  return ok({ sources: results });
}
