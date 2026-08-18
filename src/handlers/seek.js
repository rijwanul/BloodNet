import { ok, err, readJson, isValidBloodGroup, nowIso, maskMobile } from "../lib/util.js";
import { getSettings, settingInt } from "../lib/settings.js";
import { getCurrentUser, publicUserFields } from "../lib/authctx.js";
import { getLock, setLock, clearLock, checkAndBumpRateLimit } from "../lib/kvstore.js";
import { logActivity } from "../lib/activity.js";
import { sendNotificationSms, fillTemplate } from "../lib/sms.js";
import { statusLabel, CANNOT_REASON_LABELS_BN as CANNOT_REASON_LABELS } from "../lib/callLabels.js";

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

// Rows older than the rolling call-limit window are pruned lazily so a
// fresh seeking session (after the requester's rate-limit window resets)
// naturally starts without old exclusions lingering forever.
async function pruneOldExclusions(db, requesterId, windowMinutes) {
  await db
    .prepare(`DELETE FROM seek_exclusions WHERE requester_id = ? AND created_at <= datetime('now', '-${Math.max(1, windowMinutes)} minutes')`)
    .bind(requesterId)
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
  // Inside the active /seek flow the requester is by definition a logged-in
  // patient actively being matched to this donor, so every visibility tier
  // except "hidden" is shown here (this is precisely what "patients_only"
  // means - visible ONLY in this context, not on the general public page).
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

  const limitMinutes = settingInt(settings, "call_limit_minutes", 15);
  await pruneOldExclusions(env.DB, requester.id, limitMinutes);

  // Re-serve the same donor if this requester already has an active lock -
  // lets a page refresh return to the same donor instead of re-rolling.
  const existingLock = await getLock(env.KV, requester.id);
  if (existingLock) {
    const donor = await env.DB
      .prepare("SELECT u.*, (SELECT COUNT(*) FROM donations WHERE user_id = u.id) as explicit_donation_count FROM users u WHERE id = ? AND deleted = 0")
      .bind(existingLock.donorId)
      .first();
    if (donor) return ok({ donor: donorPublicShape(donor), bloodGroup: existingLock.bloodGroup || bloodGroup });
    await clearLock(env.KV, requester.id);
  }

  const limitCount = settingInt(settings, "call_limit_count", 20);
  const rate = await checkAndBumpRateLimit(env.KV, requester.id, limitCount, limitMinutes);
  if (!rate.allowed) {
    return err(
      `আপনার লিমিট শেষ হয়েছে। আপনি ${limitMinutes} মিনিট এর মধ্যে সর্বোচ্চ ${limitCount} জন ডোনারের সাথে যোগাযোগ করতে পারবেন। অনুগ্রহ করে অপেক্ষা করুন।`,
      429,
      { retryAfterSeconds: rate.retryAfterSeconds }
    );
  }

  // Never re-serve a donor already shown to THIS requester in the current
  // session, even if they've since cycled back to eligible/top-of-queue -
  // other requesters can still be shown them.
  const donor = await env.DB
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM donations WHERE user_id = u.id) as explicit_donation_count
       FROM users u
       WHERE is_donor = 1 AND blood_group = ? AND eligibility_status = 'on' AND deleted = 0
         AND id != ?
         AND (locked_by_requester_id IS NULL OR lock_expires_at <= datetime('now'))
         AND id NOT IN (SELECT donor_id FROM seek_exclusions WHERE requester_id = ?)
       ORDER BY call_sort_rank ASC, total_calls_received ASC, id ASC
       LIMIT 1`
    )
    .bind(bloodGroup, requester.id, requester.id)
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
  await setLock(env.KV, requester.id, donor.id, lockMinutes, bloodGroup);
  await env.DB
    .prepare("INSERT OR IGNORE INTO seek_exclusions (requester_id, donor_id, created_at) VALUES (?, ?, ?)")
    .bind(requester.id, donor.id, nowIso())
    .run();

  return ok({ donor: donorPublicShape(donor), bloodGroup });
}


// A call can flip a donor's eligibility a person might want to correct
// (e.g. tapped "রক্ত দিতে পারবে না" by mistake). This lets the requester
// resubmit a different status for the SAME call attempt instead of it
// being permanent the moment one status is picked.
export async function handleSeekCallStatus(request, env) {
  const requester = await getCurrentUser(request, env);
  if (!requester) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const { donorId, status, cannotReason } = body;
  const donor = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").bind(donorId).first();
  if (!donor) return err("ডোনার পাওয়া যায়নি");

  const settings = await getSettings(env.DB);
  const waitMonths = settingInt(settings, "eligibility_wait_months", 3);

  // If this requester already logged a status for this donor in the current
  // lock session, update that same row instead of inserting a duplicate -
  // this is what makes "correcting a mistake" possible.
  const existingCall = await env.DB
    .prepare("SELECT id FROM calls WHERE requester_id = ? AND donor_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(requester.id, donor.id)
    .first();
  const lock = await getLock(env.KV, requester.id);
  const isCorrection = existingCall && lock && lock.donorId === donor.id;

  if (isCorrection) {
    await env.DB
      .prepare("UPDATE calls SET status = ?, cannot_reason = ?, updated_at = ? WHERE id = ?")
      .bind(status, cannotReason || null, nowIso(), existingCall.id)
      .run();
  } else {
    await env.DB
      .prepare(
        "INSERT INTO calls (requester_id, donor_id, blood_group, status, cannot_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(requester.id, donor.id, donor.blood_group, status, cannotReason || null, nowIso(), nowIso())
      .run();
    await env.DB.prepare("UPDATE users SET total_calls_made = total_calls_made + 1 WHERE id = ?").bind(requester.id).run();
    await env.DB.prepare("UPDATE users SET total_calls_received = total_calls_received + 1 WHERE id = ?").bind(donor.id).run();
  }

  const noteForDonor = `আপনাকে ${maskMobile(requester.mobile)} কল করেছিলো। ষ্ট্যাটাস: ${statusLabel(status, cannotReason)}`;
  let eligibilityChanged = false;

  if (status === "no_answer" || status === "not_picked_up") {
    // Push to bottom of the eligible list instead of disturbing them again soon.
    await env.DB.prepare("UPDATE users SET call_sort_rank = ?, last_eligibility_change_note = ? WHERE id = ?").bind(Date.now(), noteForDonor, donor.id).run();
  } else if (status === "cannot_donate") {
    // All call-triggered eligibility changes are a TEMPORARY pause only,
    // capped at the admin's eligibility wait timeline - never permanently off.
    const until = new Date();
    until.setMonth(until.getMonth() + Math.max(1, waitMonths || 3));
    const untilIso = until.toISOString().replace("T", " ").slice(0, 19);
    const reasonLabel = CANNOT_REASON_LABELS[cannotReason] || cannotReason || "";
    await env.DB
      .prepare("UPDATE users SET eligibility_status = 'snoozed', eligibility_snooze_until = ?, eligibility_snooze_reason = ?, last_eligibility_change_note = ? WHERE id = ?")
      .bind(untilIso, reasonLabel, noteForDonor, donor.id)
      .run();
    eligibilityChanged = true;
  } else if (status === "can_donate") {
    if (!isCorrection) {
      await env.DB.prepare("UPDATE users SET donors_managed_count = donors_managed_count + 1 WHERE id = ?").bind(requester.id).run();
    }
    // Donor said yes: pause eligibility (capped at the wait timeline) and
    // flag a pending-donation prompt so /quick can surface the shortcut
    // and, if unanswered after 48h, trigger a reminder SMS.
    const until = new Date();
    until.setMonth(until.getMonth() + Math.max(1, waitMonths || 3));
    await env.DB
      .prepare(
        "UPDATE users SET eligibility_status = 'snoozed', eligibility_snooze_until = ?, last_eligibility_change_note = ?, pending_donation_prompt = 1, pending_donation_prompt_at = ?, donation_reminder_sent = 0 WHERE id = ?"
      )
      .bind(until.toISOString().replace("T", " ").slice(0, 19), noteForDonor, nowIso(), donor.id)
      .run();
    eligibilityChanged = true;
  }

  if (eligibilityChanged && settings.sms_enabled_eligibility_change_by_call !== "0") {
    const msg = fillTemplate(settings.sms_eligibility_change_by_call, { status: statusLabel(status, cannotReason) });
    await sendNotificationSms(env.DB, settings, donor.mobile, msg, "eligibility_change_by_call");
  }

  // Release the lock only for terminal outcomes; no_answer/not_picked_up frees it too (requester should move on).
  await env.DB.prepare("UPDATE users SET locked_by_requester_id = NULL, lock_expires_at = NULL WHERE id = ?").bind(donor.id).run();
  await clearLock(env.KV, requester.id);

  await logActivity(env.DB, {
    actorUser: requester,
    category: "call",
    actionText: `${requester.mobile} → ${donor.mobile} কল করেছিলেন। ষ্ট্যাটাস: ${status}${cannotReason ? " (" + (CANNOT_REASON_LABELS[cannotReason] || cannotReason) + ")" : ""}${isCorrection ? " (সংশোধিত)" : ""}`,
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

// Lets the /seek page restore exactly where a logged-in requester left off
// on refresh: if they have an active donor lock, return that donor
// (identical shape to /api/seek/lock) plus the blood group it was for.
export async function handleSeekState(request, env) {
  const requester = await getCurrentUser(request, env);
  if (!requester) return ok({ active: false });
  await releaseExpiredLocks(env.DB);
  const lock = await getLock(env.KV, requester.id);
  if (!lock) return ok({ active: false });
  const donor = await env.DB
    .prepare("SELECT u.*, (SELECT COUNT(*) FROM donations WHERE user_id = u.id) as explicit_donation_count FROM users u WHERE id = ? AND deleted = 0")
    .bind(lock.donorId)
    .first();
  if (!donor) return ok({ active: false });
  return ok({ active: true, donor: donorPublicShape(donor), bloodGroup: lock.bloodGroup || null, lockExpiresAt: lock.expiresAt || null });
}

export async function handleExternalSources(request, env) {
  const { results } = await env.DB.prepare("SELECT name, url FROM external_sources ORDER BY sort_order ASC").all();
  return ok({ sources: results });
}
