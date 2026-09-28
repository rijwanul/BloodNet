import { ok, err, readJson, isValidBloodGroup, nowIso, maskMobile, BLOOD_GROUPS } from "../lib/util.js";
import { getSettings, settingInt } from "../lib/settings.js";
import { getCurrentUser, publicUserFields } from "../lib/authctx.js";
import { getLock, setLock, clearLock, findLockForDonor, checkAndBumpRateLimit } from "../lib/kvstore.js";
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
  // A donor searching for blood of their own group should not see
  // themselves counted as an eligible donor for their own request - they
  // are the requester in this moment, not an eligible candidate for it.
  const requester = await getCurrentUser(request, env);
  const row = await env.DB
    .prepare("SELECT COUNT(*) as c FROM users WHERE is_donor = 1 AND blood_group = ? AND eligibility_status = 'on' AND deleted = 0 AND id != ?")
    .bind(bloodGroup, requester ? requester.id : 0)
    .first();
  // This endpoint needs no login (getCurrentUser above returns null
  // gracefully when logged out), so it's the earliest point the frontend
  // can know the count is zero - bundling externalSources here lets the
  // seek page show alternative resources immediately instead of forcing
  // a logged-out visitor through the mobile-number gate first only to
  // land on the exact same "no donors" message afterwards.
  let externalSources = [];
  if (row.c === 0) {
    const { results } = await env.DB.prepare("SELECT name, url FROM external_sources ORDER BY sort_order ASC").all();
    externalSources = results;
  }
  return ok({ count: row.c, externalSources });
}

function donorPublicShape(d, settings) {
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
    mobileMasked: maskMobile(d.mobile, settings),
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

// True once the number has actually been revealed for this requester+donor
// pair (a 'pending' or later-status calls row exists) - used to tell the
// frontend to skip straight past the reveal+countdown UI on a page refresh
// instead of restarting the 20-second timer from zero every time.
async function hasCallStarted(db, requesterId, donorId) {
  const row = await db.prepare("SELECT id FROM calls WHERE requester_id = ? AND donor_id = ? ORDER BY created_at DESC LIMIT 1").bind(requesterId, donorId).first();
  return !!row;
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

  // Re-serve the same donor if this requester already has an active lock
  // FOR THIS BLOOD GROUP specifically - lets a page refresh return to the
  // same donor instead of re-rolling, without leaking a stale lock from a
  // previously (or simultaneously) browsed different blood group. Each
  // blood group gets its own independent lock, so a requester who starts
  // an O+ search, backs out, and starts an A+ search gets a genuinely fresh
  // A+ match instead of being stuck with whatever donor O+ had locked.
  const existingLock = await getLock(env.KV, requester.id, bloodGroup);
  if (existingLock) {
    const donor = await env.DB
      .prepare("SELECT u.*, (SELECT COUNT(*) FROM donations WHERE user_id = u.id) as explicit_donation_count FROM users u WHERE id = ? AND deleted = 0")
      .bind(existingLock.donorId)
      .first();
    if (donor) return ok({ donor: donorPublicShape(donor, settings), bloodGroup, alreadyCalled: await hasCallStarted(env.DB, requester.id, existingLock.donorId) });
    await clearLock(env.KV, requester.id, bloodGroup);
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
  // other requesters can still be shown them. A requester also never gets
  // matched to themselves, even if they happen to be an eligible donor of
  // the exact group they're searching for.
  const donor = await env.DB
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM donations WHERE user_id = u.id) as explicit_donation_count
       FROM users u
       WHERE is_donor = 1 AND blood_group = ? AND eligibility_status = 'on' AND deleted = 0
         AND id != ?
         AND (locked_by_requester_id IS NULL OR lock_expires_at <= datetime('now'))
         AND id NOT IN (SELECT donor_id FROM seek_exclusions WHERE requester_id = ? AND blood_group = ?)
       ORDER BY call_sort_rank ASC, total_calls_received ASC, id ASC
       LIMIT 1`
    )
    .bind(bloodGroup, requester.id, requester.id, bloodGroup)
    .first();

  if (!donor) {
    // Session-exhausted: no eligible donor remains for this requester+group
    // that hasn't already been shown to them. Per spec, this counts as the
    // seeking session ending - if they come back and pick the same blood
    // group again later (even seconds later), it should behave as a brand
    // new request, so donors already shown in the now-finished session
    // become eligible to be shown again. Clearing the exclusions here means
    // the NEXT /api/seek/lock call for this requester+group starts fresh,
    // rather than waiting on the unrelated call-limit rate-window to expire.
    await env.DB.prepare("DELETE FROM seek_exclusions WHERE requester_id = ? AND blood_group = ?").bind(requester.id, bloodGroup).run();
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
    .prepare("INSERT OR IGNORE INTO seek_exclusions (requester_id, donor_id, blood_group, created_at) VALUES (?, ?, ?, ?)")
    .bind(requester.id, donor.id, bloodGroup, nowIso())
    .run();

  return ok({ donor: donorPublicShape(donor, settings), bloodGroup });
}


// A call can flip a donor's eligibility a person might want to correct
// (e.g. tapped "রক্ত দিতে পারবে না" by mistake). This lets the requester
// resubmit a different status for the SAME call attempt instead of it
// being permanent the moment one status is picked.
//
// Two ways in:
//  - donorId (the normal /seek flow) - resolves against whichever call row
//    is tied to a currently-LIVE lock, as before.
//  - callId (the site-wide /calls history page's "আপডেট করুন" button on an
//    old pending entry) - directly targets that exact row, ownership-
//    checked, with no lock requirement at all, since by the time someone
//    is updating history from that page the seek session is long over.
const VALID_CALL_STATUSES = new Set(["no_answer", "not_picked_up", "cannot_donate", "can_donate", "not_called", "skipped"]);

export async function handleSeekCallStatus(request, env) {
  const requester = await getCurrentUser(request, env);
  if (!requester) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const { donorId, callId, status } = body;
  if (!VALID_CALL_STATUSES.has(status)) return err("অবৈধ ষ্ট্যাটাস");
  // The "কাষ্টম ব্যখ্যা" free-text reason (not_called only) is
  // capped at 100 chars, matching the frontend input's maxlength - trimmed
  // and hard-capped server-side too so a direct API call can't bypass the
  // UI limit. Fixed reason keys (note_reason, blood_not_needed, other,
  // not_yet_eligible, etc) pass through untouched since they're well
  // under 100 chars anyway.
  const cannotReason = typeof body.cannotReason === "string" ? body.cannotReason.trim().slice(0, 100) : body.cannotReason;

  if (callId) {
    const row = await env.DB.prepare("SELECT id, donor_id, status FROM calls WHERE id = ? AND requester_id = ?").bind(callId, requester.id).first();
    if (!row) return err("এন্ট্রি পাওয়া যায়নি অথবা আপনার নয়", 404);
    return applyCallStatus(env, requester, row.donor_id, row.id, row.status !== "pending", status, cannotReason, null, false);
  }

  const donor = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").bind(donorId).first();
  if (!donor) return err("ডোনার পাওয়া যায়নি");

  // Whether this is "the same call attempt" (update in place, allows the
  // "ভুল হয়েছে?" correction) vs "a new call attempt on a returning session"
  // (insert a fresh row, so the same donor can accumulate multiple distinct
  // call statuses over time) hinges on whether requester+donor currently
  // have a LIVE lock - not merely whether any calls row exists between them
  // at all. A requester who completed a session (saw "no more donors",
  // clicked আবার শুরু করুন, etc) and later calls the SAME donor again via a
  // brand new session has no active lock at that point, so this correctly
  // creates a new call record instead of overwriting the earlier one.
  const lock = await findLockForDonor(env.KV, requester.id, donor.id, BLOOD_GROUPS);
  const existingCall = lock
    ? await env.DB
        .prepare("SELECT id, status FROM calls WHERE requester_id = ? AND donor_id = ? ORDER BY created_at DESC LIMIT 1")
        .bind(requester.id, donor.id)
        .first()
    : null;

  if (existingCall) {
    return applyCallStatus(env, requester, donor.id, existingCall.id, existingCall.status !== "pending", status, cannotReason, lock, false);
  }

  // No live-session call row to update - either genuinely the first call
  // to this donor, or a new session's call to a donor already called in
  // an earlier, now-finished session. Either way this is a fresh row.
  const ins = await env.DB
    .prepare("INSERT INTO calls (requester_id, donor_id, blood_group, status, cannot_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(requester.id, donor.id, donor.blood_group, status, cannotReason || null, nowIso(), nowIso())
    .run();
  // "skipped" means the requester explicitly chose NOT to call this donor -
  // counting it toward "calls made/received" would misrepresent both
  // sides' stats (a donor's "total calls received" should mean calls, not
  // skips), so these counters only move for every other status.
  if (status !== "skipped") {
    await env.DB.prepare("UPDATE users SET total_calls_made = total_calls_made + 1 WHERE id = ?").bind(requester.id).run();
    await env.DB.prepare("UPDATE users SET total_calls_received = total_calls_received + 1 WHERE id = ?").bind(donor.id).run();
  }
  return applyCallStatus(env, requester, donor.id, ins.meta.last_row_id, false, status, cannotReason, lock, true);
}

// Shared tail end: applies the eligibility side effects, sends the
// notification SMS, releases any lock, and logs the activity entry.
// skipRowWrite true means the caller already inserted the row itself (the
// brand-new-call path above) so this only needs to act on side effects,
// never write status again here; otherwise this UPDATEs the given row.
async function applyCallStatus(env, requester, donorId, callRowId, isCorrection, status, cannotReason, lock, skipRowWrite) {
  const donor = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(donorId).first();
  const settings = await getSettings(env.DB);
  const waitMonths = settingInt(settings, "eligibility_wait_months", 3);

  if (!skipRowWrite) {
    await env.DB
      .prepare("UPDATE calls SET status = ?, cannot_reason = ?, updated_at = ? WHERE id = ?")
      .bind(status, cannotReason || null, nowIso(), callRowId)
      .run();
  }

  const noteForDonor = `আপনাকে ${maskMobile(requester.mobile, settings)} কল করেছিলো। ষ্ট্যাটাস: ${statusLabel(status, cannotReason)}`;
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

  // These operations don't depend on each other's results, so they run
  // concurrently instead of one-after-another - this was the main source of
  // the noticeable delay between tapping a status button and seeing the
  // "ষ্ট্যাটাস সংরক্ষণ করা হয়েছে" confirmation, since each round-trip to
  // D1/KV/the SMS provider was previously awaited in sequence.
  await Promise.all([
    eligibilityChanged && settings.sms_enabled_eligibility_change_by_call !== "0"
      ? sendNotificationSms(env.DB, settings, donor.mobile, fillTemplate(settings.sms_eligibility_change_by_call, { status: statusLabel(status, cannotReason) }, settings), "eligibility_change_by_call")
      : Promise.resolve(),
    // Release the lock only for terminal outcomes; no_answer/not_picked_up frees it too (requester should move on).
    env.DB.prepare("UPDATE users SET locked_by_requester_id = NULL, lock_expires_at = NULL WHERE id = ?").bind(donor.id).run(),
    lock ? clearLock(env.KV, requester.id, lock.bloodGroup) : Promise.resolve(),
    logActivity(env.DB, {
      actorUser: requester,
      category: "call",
      actionText: `${requester.mobile} → ${donor.mobile} কল করেছিলেন। ষ্ট্যাটাস: ${statusLabel(status, cannotReason)}${isCorrection ? " (সংশোধিত)" : ""}`,
    }),
  ]);

  return ok({ recorded: true });
}

export async function handleSeekDonorNumber(request, env) {
  const requester = await getCurrentUser(request, env);
  if (!requester) return err("লগইন প্রয়োজন", 401);
  const url = new URL(request.url);
  const donorId = parseInt(url.searchParams.get("donorId"), 10);
  const bloodGroup = url.searchParams.get("bloodGroup");
  if (!donorId) return err("সঠিক ডোনার আইডি দিন");

  // Only reveal the real number if this donor is actually currently locked
  // to this requester - prevents scraping numbers by guessing donor ids.
  // Checks the specific blood-group lock the frontend is currently on
  // first (cheap, single KV read); falls back to scanning all groups only
  // if that's missing, so an older client that hasn't sent bloodGroup yet
  // still works during rollout.
  const lock = (bloodGroup && (await getLock(env.KV, requester.id, bloodGroup))) || (await findLockForDonor(env.KV, requester.id, donorId, BLOOD_GROUPS));
  if (!lock || lock.donorId !== donorId) {
    return err("এই ডোনারের সাথে আপনার কোনো সক্রিয় লক নেই", 403);
  }

  const donor = await env.DB.prepare("SELECT mobile, blood_group FROM users WHERE id = ? AND deleted = 0").bind(donorId).first();
  if (!donor) return err("ডোনার পাওয়া যায়নি", 404);

  // Record the call attempt as "pending" the moment the number is actually
  // revealed (i.e. the requester is about to place the call), not only once
  // a status is later chosen. Without this, a requester who calls and then
  // closes the app before picking a status left no trace at all - now that
  // shows up in both parties' call history as "ষ্ট্যাটাস আপডেট করা হয়নি"
  // instead of silently not existing. handleSeekCallStatus updates this
  // same row (treating it like a correction) once a real status comes in.
  const existing = await env.DB
    .prepare("SELECT id FROM calls WHERE requester_id = ? AND donor_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(requester.id, donorId)
    .first();
  if (!existing) {
    await env.DB
      .prepare("INSERT INTO calls (requester_id, donor_id, blood_group, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind(requester.id, donorId, donor.blood_group, nowIso(), nowIso())
      .run();
    await env.DB.prepare("UPDATE users SET total_calls_made = total_calls_made + 1 WHERE id = ?").bind(requester.id).run();
    await env.DB.prepare("UPDATE users SET total_calls_received = total_calls_received + 1 WHERE id = ?").bind(donorId).run();
  }

  return ok({ mobile: donor.mobile });
}

// Lets the /seek page restore exactly where a logged-in requester left off
// on refresh: if they have an active donor lock FOR THE GIVEN BLOOD GROUP,
// return that donor (identical shape to /api/seek/lock). Requires
// bloodGroup now since locks are scoped per group - without knowing which
// group the frontend is currently showing, there could be several
// simultaneously-active locks (one per group) and no way to pick the
// right one.
export async function handleSeekState(request, env) {
  const requester = await getCurrentUser(request, env);
  if (!requester) return ok({ active: false });
  const url = new URL(request.url);
  const bloodGroup = url.searchParams.get("bloodGroup");
  if (!isValidBloodGroup(bloodGroup)) return ok({ active: false });
  await releaseExpiredLocks(env.DB);
  const lock = await getLock(env.KV, requester.id, bloodGroup);
  if (!lock) return ok({ active: false });
  const settings = await getSettings(env.DB);
  const donor = await env.DB
    .prepare("SELECT u.*, (SELECT COUNT(*) FROM donations WHERE user_id = u.id) as explicit_donation_count FROM users u WHERE id = ? AND deleted = 0")
    .bind(lock.donorId)
    .first();
  if (!donor) return ok({ active: false });
  return ok({ active: true, donor: donorPublicShape(donor, settings), bloodGroup, lockExpiresAt: lock.expiresAt || null, alreadyCalled: await hasCallStarted(env.DB, requester.id, lock.donorId) });
}

export async function handleExternalSources(request, env) {
  const { results } = await env.DB.prepare("SELECT name, url FROM external_sources ORDER BY sort_order ASC").all();
  return ok({ sources: results });
}
