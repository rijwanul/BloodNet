import { ok, err, readJson, isValidBloodGroup, isValidUsernameSlug, genRandomSlug, genUniqueRandomSlug, getReservedSlugSet, nowIso } from "../lib/util.js";
import { getSettings, settingBool } from "../lib/settings.js";
import { getCurrentUser, clearSessionCookie } from "../lib/authctx.js";
import { logActivity } from "../lib/activity.js";
import { donorbdCheckAvailability, donorbdNewEntry, donorbdDeleteEntry } from "../lib/donorbd.js";
import { uploadToImgbb } from "../lib/imgbb.js";
import { receivedCallsSummaryFor } from "./calls.js";

// Each visibility-controllable field has its own allowed value set:
//  - "patients_only" means "visible only while this donor is being actively
//    shown to a requester inside the /seek flow" - NOT "any logged-in user
//    browsing the public profile page". The general public profile page
//    never reveals patients_only fields to anyone but the owner.
//  - "login" (লগইন করা ইউজার) means visible to any logged-in viewer on the
//    general public profile page.
const FIELD_VISIBILITY_OPTIONS = {
  mobile: ["public", "login", "patients_only", "hidden"],
  address_summary: ["public", "login", "patients_only", "hidden"],
  location: ["public", "login", "patients_only", "hidden"],
  last_donation_date: ["public", "login", "patients_only", "hidden"],
  total_donations: ["public", "login", "patients_only", "hidden"],
  donation_history_tab: ["public", "login", "hidden"],
  call_history_tab: ["public", "login", "hidden"],
  eligibility_status: ["public", "login", "hidden"],
  note: ["public", "login"], // never hidden - donor can just save an empty note instead
};
const DEFAULT_VISIBILITY = {
  mobile: "patients_only",
  address_summary: "patients_only",
  location: "patients_only",
  last_donation_date: "public",
  total_donations: "public",
  donation_history_tab: "public",
  call_history_tab: "public",
  eligibility_status: "public",
  note: "public",
};
const ALWAYS_PUBLIC = ["name", "username"];

function safeJson(s, fallback = {}) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return fallback;
  }
}

async function donationCount(db, userId) {
  const row = await db.prepare("SELECT COUNT(*) c FROM donations WHERE user_id = ?").bind(userId).first();
  return row.c;
}

export async function handleProfileMe(request, env) {
  let user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);

  // If this donor's snooze has already expired, flip them back to
  // eligible right now rather than waiting for some unrelated requester's
  // search to trigger the sweep - otherwise a donor loading their own
  // profile right as their "সময় শেষ" countdown hits zero would still see
  // themselves as snoozed until someone else happened to search nearby.
  if (user.is_donor && user.eligibility_status === "snoozed" && user.eligibility_snooze_until && user.eligibility_snooze_until <= nowIso()) {
    await env.DB.prepare("UPDATE users SET eligibility_status = 'on', eligibility_snooze_until = NULL, eligibility_snooze_reason = NULL WHERE id = ?").bind(user.id).run();
    user = { ...user, eligibility_status: "on", eligibility_snooze_until: null, eligibility_snooze_reason: null };
  }

  const explicit = await donationCount(env.DB, user.id);
  const totalDonations = explicit + (user.extra_donation_count || 0);
  const location = user.location_id
    ? await env.DB.prepare("SELECT name FROM locations WHERE id = ?").bind(user.location_id).first()
    : null;

  return ok({
    profile: {
      id: user.id,
      mobile: user.mobile,
      name: user.name,
      username: user.username_display,
      profilePicUrl: user.profile_pic_url,
      isDonor: !!user.is_donor,
      bloodGroup: user.blood_group,
      lastDonationDate: user.last_donation_date,
      addressSummary: user.address_summary,
      locationName: location ? location.name : null,
      locationId: user.location_id,
      note: user.donor_note,
      publicProfileView: user.public_profile_view || "tabs",
      totalDonations,
      totalCallsMade: user.total_calls_made,
      totalCallsReceived: user.total_calls_received,
      donorsManagedCount: user.donors_managed_count,
      createdAt: user.created_at,
      eligibilityStatus: user.eligibility_status,
      eligibilitySnoozeUntil: user.eligibility_snooze_until,
      eligibilitySnoozeReason: user.eligibility_snooze_reason,
      visibility: { ...DEFAULT_VISIBILITY, ...safeJson(user.visibility_json) },
    },
  });
}

export async function handleProfileEdit(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const fields = [];
  const values = [];

  if (typeof body.name === "string") {
    fields.push("name = ?");
    values.push(body.name.slice(0, 60));
  }
  if (body.bloodGroup) {
    if (!isValidBloodGroup(body.bloodGroup)) return err("সঠিক রক্তের গ্রুপ দিন");
    fields.push("blood_group = ?");
    values.push(body.bloodGroup);
  }
  if (typeof body.lastDonationDate === "string") {
    fields.push("last_donation_date = ?");
    values.push(body.lastDonationDate || null);
    // A changed donation date restarts the wait-period clock, so the
    // reopen-reminder SMS should be able to fire again for the new cycle
    // rather than staying suppressed by its repeat window from before.
    fields.push("eligibility_reopen_note_sent_at = NULL");
  }
  if (typeof body.addressSummary === "string") {
    fields.push("address_summary = ?");
    values.push(body.addressSummary.slice(0, 200));
  }
  if (body.locationId !== undefined) {
    fields.push("location_id = ?");
    values.push(body.locationId || null);
  }
  if (typeof body.note === "string") {
    fields.push("donor_note = ?");
    values.push(body.note.slice(0, 300)); // empty string is allowed - donor can save a blank note
  }
  if (body.publicProfileView === "tabs" || body.publicProfileView === "list") {
    fields.push("public_profile_view = ?");
    values.push(body.publicProfileView);
  }

  // Profile picture upload (base64 image data sent from client) or removal
  if (body.removeProfilePic) {
    fields.push("profile_pic_url = ?", "profile_pic_delete_url = ?");
    values.push(null, null);
  } else if (body.profilePicBase64) {
    const settings = await getSettings(env.DB);
    try {
      const { url, deleteUrl } = await uploadToImgbb(settings.imgbb_api_key, body.profilePicBase64);
      fields.push("profile_pic_url = ?", "profile_pic_delete_url = ?");
      values.push(url, deleteUrl);
    } catch (e) {
      // Never leak which third-party provider is behind image hosting in
      // an error a user can see - and log the failure (with the filename,
      // when the client sends one) for admin visibility instead.
      await logActivity(env.DB, {
        actorUser: user,
        category: "system",
        actionText: `প্রোফাইল ছবি আপলোড ব্যর্থ হয়েছে${body.profilePicFileName ? ` (ফাইল: ${body.profilePicFileName})` : ""}: ${String(e.message || e)}`,
      });
      return err("আপলোড ব্যর্থ হয়েছে।");
    }
  }

  if (!fields.length) return err("কোনো পরিবর্তন পাওয়া যায়নি");
  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  await logActivity(env.DB, { actorUser: user, category: "account", actionText: "প্রোফাইল তথ্য আপডেট করেছেন" });
  return ok({ updated: true });
}

export async function handleBecomeDonor(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  if (user.is_donor) return err("আপনি ইতিমধ্যে ডোনার");
  const body = await readJson(request);
  if (!isValidBloodGroup(body.bloodGroup)) return err("সঠিক রক্তের গ্রুপ দিন");

  // A new donor always starts with availability OFF - they must turn the
  // switch on themselves (the frontend tells them so and sends them to the
  // Quick tab). last_donation_date is still stored below; it is no longer
  // used to auto-snooze a brand-new donor, since a snooze would flip
  // availability ON by itself once it expires.
  const eligibilityStatus = "off";
  const snoozeUntil = null;

  await env.DB
    .prepare(
      `UPDATE users SET is_donor = 1, blood_group = ?, last_donation_date = ?, address_summary = ?, location_id = ?,
       eligibility_status = ?, eligibility_snooze_until = ?, updated_at = ? WHERE id = ?`
    )
    .bind(
      body.bloodGroup,
      body.lastDonationDate || null,
      body.addressSummary || null,
      body.locationId || null,
      eligibilityStatus,
      snoozeUntil,
      nowIso(),
      user.id
    )
    .run();

  await logActivity(env.DB, { actorUser: user, category: "account", actionText: "ডোনার হিসেবে যুক্ত হয়েছেন" });
  return ok({ isDonor: true });
}

function normalizeSlug(slug) {
  return (slug || "").trim();
}

export async function handleUsernameCheck(request, env) {
  const url = new URL(request.url);
  const slug = normalizeSlug(url.searchParams.get("slug"));
  if (!isValidUsernameSlug(slug)) return err("ইউজারনেইম অবৈধ (৩-৩২ অক্ষর, শুধু a-z, 0-9, _, -)");
  const reserved = await getReservedSlugSet(env.DB);
  if (reserved.has(slug.toLowerCase())) return ok({ available: false, reason: "reserved" });
  const settings = await getSettings(env.DB);
  const localTaken = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username_slug) = LOWER(?)").bind(slug).first();
  if (localTaken) return ok({ available: false, reason: "local" });
  if (settingBool(settings, "donorbd_check_before_claim", true)) {
    const remote = await donorbdCheckAvailability(settings, slug.toLowerCase());
    if (remote.configured && !remote.available) return ok({ available: false, reason: "donorbd" });
  }
  return ok({ available: true });
}

export async function handleUsernameClaim(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const slug = normalizeSlug(body.slug);
  if (!isValidUsernameSlug(slug)) return err("ইউজারনেইম অবৈধ (৩-৩২ অক্ষর, শুধু a-z, 0-9, _, -)");

  const reserved = await getReservedSlugSet(env.DB);
  if (reserved.has(slug.toLowerCase())) return err("এই ইউজারনেইমটি ক্লেইম করা যাচ্ছে না");

  const settings = await getSettings(env.DB);
  const localTaken = await env.DB
    .prepare("SELECT id FROM users WHERE LOWER(username_slug) = LOWER(?) AND id != ?")
    .bind(slug, user.id)
    .first();
  if (localTaken) return err("এই ইউজারনেইম ইতিমধ্যে ব্যবহৃত হচ্ছে");

  const checkRequired = settingBool(settings, "donorbd_check_before_claim", true);
  if (checkRequired) {
    const remote = await donorbdCheckAvailability(settings, slug.toLowerCase());
    if (remote.configured && !remote.available) return err("এই ইউজারনেইমটি ক্লেইম করা যাচ্ছে না");
  }

  // Admin can point the shared/short link at a different base (e.g. their
  // own donor.bd-style short domain) purely for display; the donor.bd
  // registry entry itself always targets this app's real origin.
  const baseUrl = new URL(request.url).origin;
  if (user.username_slug) {
    await donorbdDeleteEntry(settings, user.username_slug.toLowerCase()).catch(() => {});
  }
  const entryResult = await donorbdNewEntry(settings, { target: `${baseUrl}/${slug}`, slug: slug.toLowerCase() });
  if (entryResult.configured && !entryResult.ok) {
    return err("donor.bd তে এন্ট্রি তৈরি করতে ব্যর্থ হয়েছে, পরে আবার চেষ্টা করুন");
  }

  await env.DB
    .prepare("UPDATE users SET username_slug = ?, username_display = ?, donorbd_slug_registered = ?, updated_at = ? WHERE id = ?")
    .bind(slug.toLowerCase(), slug, entryResult.configured ? 1 : 0, nowIso(), user.id)
    .run();
  await logActivity(env.DB, { actorUser: user, category: "account", actionText: `ইউজারনেইম সেট করেছেন: ${slug}` });
  return ok({ username: slug });
}

export async function handleProfileVisibility(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);

  // Reset-to-default: clears visibility_json entirely so DEFAULT_VISIBILITY
  // applies cleanly, rather than the frontend having to know/duplicate
  // what the defaults are.
  if (body.reset) {
    await env.DB.prepare("UPDATE users SET visibility_json = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), user.id).run();
    await logActivity(env.DB, { actorUser: user, category: "account", actionText: "গোপনীয়তা সেটিংস ডিফল্টে রিসেট করেছেন" });
    return ok({ visibility: DEFAULT_VISIBILITY });
  }

  const incoming = body.visibility || {};
  const current = { ...DEFAULT_VISIBILITY, ...safeJson(user.visibility_json) };
  for (const [k, v] of Object.entries(incoming)) {
    if (ALWAYS_PUBLIC.includes(k)) continue;
    const allowed = FIELD_VISIBILITY_OPTIONS[k];
    if (allowed && allowed.includes(v)) current[k] = v;
  }
  await env.DB.prepare("UPDATE users SET visibility_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(current), nowIso(), user.id).run();
  return ok({ visibility: current });
}

export async function handleDonationsList(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  // Dated entries first (newest first), undated entries (date শোন করা - shown
  // as a dash by the frontend) after them - donation_date DESC already puts
  // NULLs last in SQLite's default ordering, so no special-casing needed here.
  const { results } = await env.DB
    .prepare("SELECT id, hospital_name, donation_date FROM donations WHERE user_id = ? ORDER BY donation_date DESC, id DESC")
    .bind(user.id)
    .all();
  return ok({ donations: results, extraCount: user.extra_donation_count || 0 });
}

// Single entry point for adding a donation record, covering three cases:
//  - dateUnknown false -> a normal dated entry (hospitalName optional,
//    independently markable as unknown/blank).
//  - dateUnknown true, hospitalUnknown false, moreUnknownExist false -> the
//    donor remembers the HOSPITAL but not the date. This is still its own
//    row (donation_date = NULL) so the hospital name isn't lost - shown in
//    the list with a dash for the date, sorted below dated entries.
//  - dateUnknown true, moreUnknownExist true -> donor provides the GRAND
//    TOTAL of undated-and-unremembered donations (including this one),
//    replacing the extra-count bucket outright rather than adding to it.
//    This bucket is for donations with NEITHER a date NOR a hospital name
//    remembered - if a hospital name is known, use the row-per-entry path
//    above instead, even when moreUnknownExist is also checked (in that
//    case the current entry becomes its own dated-hospital-only row, and
//    moreUnknownExist covers ONLY the additional fully-forgotten ones).
export async function handleDonationsAdd(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const dateUnknown = !!body.dateUnknown;
  const hospitalUnknown = !!body.hospitalUnknown;

  if (!dateUnknown) {
    const date = body.date;
    if (!date) return err("তারিখ দিন, অথবা 'মনে নেই' নির্বাচন করুন");
    const hospitalName = hospitalUnknown ? null : (body.hospitalName || null);
    await env.DB
      .prepare("INSERT INTO donations (user_id, hospital_name, donation_date, created_at) VALUES (?, ?, ?, ?)")
      .bind(user.id, hospitalName, date, nowIso())
      .run();
    await env.DB
      .prepare("UPDATE users SET last_donation_date = ?, eligibility_reopen_note_sent_at = NULL, updated_at = ? WHERE id = ? AND (last_donation_date IS NULL OR last_donation_date < ?)")
      .bind(date, nowIso(), user.id, date)
      .run();
    await logActivity(env.DB, { actorUser: user, category: "donation", actionText: `পূর্বের রক্তদানের তথ্য যোগ করেছেন (${date})` });
    return ok({ added: true });
  }

  // dateUnknown = true, hospital name IS known -> its own undated row.
  if (!hospitalUnknown && body.hospitalName) {
    await env.DB
      .prepare("INSERT INTO donations (user_id, hospital_name, donation_date, created_at) VALUES (?, ?, NULL, ?)")
      .bind(user.id, body.hospitalName, nowIso())
      .run();
    await logActivity(env.DB, { actorUser: user, category: "donation", actionText: `পূর্বের রক্তদানের তথ্য যোগ করেছেন (তারিখ মনে নেই, ${body.hospitalName})` });

    // moreUnknownExist can still apply on top, for OTHER donations where
    // neither the date nor the hospital is remembered.
    if (body.moreUnknownExist) {
      const total = parseInt(body.totalUnknownCount, 10);
      if (!Number.isFinite(total) || total < 1 || total > 500) return err("সঠিক সংখ্যা দিন (কমপক্ষে ১)");
      await env.DB.prepare("UPDATE users SET extra_donation_count = ?, updated_at = ? WHERE id = ?").bind(total, nowIso(), user.id).run();
      await logActivity(env.DB, { actorUser: user, category: "donation", actionText: `মনে না থাকা রক্তদানের মোট সংখ্যা সেট করেছেন (${total})` });
      return ok({ added: true, extraCount: total });
    }
    return ok({ added: true });
  }

  // dateUnknown = true, hospital ALSO unknown -> the anonymous bucket.
  if (body.moreUnknownExist) {
    const total = parseInt(body.totalUnknownCount, 10);
    if (!Number.isFinite(total) || total < 1 || total > 500) return err("সঠিক সংখ্যা দিন (কমপক্ষে ১)");
    await env.DB.prepare("UPDATE users SET extra_donation_count = ?, updated_at = ? WHERE id = ?").bind(total, nowIso(), user.id).run();
    await logActivity(env.DB, { actorUser: user, category: "donation", actionText: `মনে না থাকা রক্তদানের মোট সংখ্যা সেট করেছেন (${total})` });
    return ok({ extraCount: total });
  }

  await env.DB.prepare("UPDATE users SET extra_donation_count = extra_donation_count + 1, updated_at = ? WHERE id = ?").bind(nowIso(), user.id).run();
  await logActivity(env.DB, { actorUser: user, category: "donation", actionText: "মনে না থাকা একটি রক্তদান যোগ করেছেন" });
  const row = await env.DB.prepare("SELECT extra_donation_count FROM users WHERE id = ?").bind(user.id).first();
  return ok({ extraCount: row.extra_donation_count });
}

// Editing a donation entry: either field can be updated independently.
// Passing date: null clears the date (moves the entry to the undated
// group); hospitalName: null clears the hospital name. last_donation_date
// on the user record is NOT recomputed here - it only ever advances
// forward via handleDonationsAdd's dated-entry path, so editing/deleting a
// past entry deliberately leaves it alone rather than silently rewriting
// donor-facing "সর্বশেষ রক্তদান" based on an edit to older history.
export async function handleDonationEdit(request, env, idStr) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const id = parseInt(idStr, 10);
  const body = await readJson(request);
  const row = await env.DB.prepare("SELECT id FROM donations WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!row) return err("এন্ট্রি পাওয়া যায়নি", 404);

  const date = body.dateUnknown ? null : (body.date || null);
  const hospitalName = body.hospitalUnknown ? null : (body.hospitalName || null);
  if (!date && !hospitalName) return err("তারিখ অথবা হাসপাতালের নাম অন্তত একটি দিন");

  await env.DB.prepare("UPDATE donations SET hospital_name = ?, donation_date = ? WHERE id = ? AND user_id = ?").bind(hospitalName, date, id, user.id).run();
  await logActivity(env.DB, { actorUser: user, category: "donation", actionText: "একটি রক্তদান এন্ট্রি সম্পাদনা করেছেন" });
  return ok({ updated: true });
}

export async function handleDonationDelete(request, env, idStr) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const id = parseInt(idStr, 10);
  const row = await env.DB.prepare("SELECT id FROM donations WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!row) return err("এন্ট্রি পাওয়া যায়নি", 404);
  await env.DB.prepare("DELETE FROM donations WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  await logActivity(env.DB, { actorUser: user, category: "donation", actionText: "একটি রক্তদান এন্ট্রি ডিলিট করেছেন" });
  return ok({ deleted: true });
}

export async function handleProfileDelete(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const settings = await getSettings(env.DB);
  if (!settingBool(settings, "self_deletion_enabled", true)) return err("প্রোফাইল ডিলেট বর্তমানে বন্ধ রাখা হয়েছে");
  const body = await readJson(request);
  if ((body.mobileConfirm || "").trim() !== user.mobile) return err("মোবাইল নাম্বার মিলছে না");

  if (user.username_slug) {
    await donorbdDeleteEntry(settings, user.username_slug.toLowerCase()).catch(() => {});
  }

  const anonId = `deleted_${user.id}`;
  await env.DB
    .prepare(
      "UPDATE users SET deleted = 1, name = 'ডিলিটেড একাউন্ট', mobile = ?, username_slug = NULL, username_display = NULL, password_hash = 'deleted', updated_at = ? WHERE id = ?"
    )
    .bind(anonId, nowIso(), user.id)
    .run();

  await logActivity(env.DB, {
    actorLabel: user.username_display || user.mobile,
    category: "account",
    actionText: `একাউন্ট ডিলিট করা হয়েছে (পূর্বের নাম্বার: ${user.mobile})`,
  });
  return ok({ deleted: true }, { headers: { "Set-Cookie": clearSessionCookie(request) } });
}

const ELIGIBILITY_LABELS_BN = { on: "চালু আছে", snoozed: "সাময়িক বন্ধ", off: "বন্ধ" };

export async function handlePublicProfile(request, env, slug) {
  let user = await env.DB.prepare("SELECT * FROM users WHERE LOWER(username_slug) = LOWER(?) AND deleted = 0").bind(slug).first();
  if (!user) return err("প্রোফাইল পাওয়া যায়নি", 404);

  // Same targeted wake-check as handleProfileMe - a visitor to this
  // profile shouldn't see a stale "snoozed" eligibility that's actually
  // already expired, just because no unrelated /seek search happened to
  // trigger the general sweep yet.
  if (user.is_donor && user.eligibility_status === "snoozed" && user.eligibility_snooze_until && user.eligibility_snooze_until <= nowIso()) {
    await env.DB.prepare("UPDATE users SET eligibility_status = 'on', eligibility_snooze_until = NULL, eligibility_snooze_reason = NULL WHERE id = ?").bind(user.id).run();
    user = { ...user, eligibility_status: "on", eligibility_snooze_until: null, eligibility_snooze_reason: null };
  }

  const viewer = await getCurrentUser(request, env);
  const vis = { ...DEFAULT_VISIBILITY, ...safeJson(user.visibility_json) };
  const explicit = await donationCount(env.DB, user.id);
  const totalDonations = explicit + (user.extra_donation_count || 0);
  const location = user.location_id ? await env.DB.prepare("SELECT name FROM locations WHERE id = ?").bind(user.location_id).first() : null;

  const isSelf = viewer && viewer.id === user.id;
  // "patients_only" is intentionally excluded here - it only applies inside
  // the active /seek flow, never on the general public profile page.
  const show = (field) => isSelf || vis[field] === "public" || (vis[field] === "login" && !!viewer);

  let donations = [];
  if (show("donation_history_tab")) {
    const { results } = await env.DB.prepare("SELECT id, hospital_name, donation_date FROM donations WHERE user_id = ? ORDER BY donation_date DESC").bind(user.id).all();
    donations = results;
  }
  let calls = [];
  if (show("call_history_tab")) {
    const settings = await getSettings(env.DB);
    calls = await receivedCallsSummaryFor(env.DB, user.id, settings);
  }

  return ok({
    profile: {
      id: user.id,
      name: user.name,
      username: user.username_display,
      profilePicUrl: user.profile_pic_url,
      isDonor: !!user.is_donor,
      bloodGroup: user.blood_group,
      note: show("note") ? user.donor_note : null,
      totalDonations: show("total_donations") ? totalDonations : null,
      lastDonationDate: show("last_donation_date") ? user.last_donation_date : null,
      addressSummary: show("address_summary") ? user.address_summary : null,
      locationName: show("location") && location ? location.name : null,
      mobile: show("mobile") ? user.mobile : null,
      eligibilityStatus: show("eligibility_status") ? user.eligibility_status : null,
      eligibilitySnoozeUntil: show("eligibility_status") ? user.eligibility_snooze_until : null,
      eligibilityLabel: show("eligibility_status") ? ELIGIBILITY_LABELS_BN[user.eligibility_status] || user.eligibility_status : null,
      donationHistoryVisible: show("donation_history_tab"),
      callHistoryVisible: show("call_history_tab"),
      donations,
      calls,
      extraDonationCount: show("total_donations") ? (user.extra_donation_count || 0) : null,
      explicitDonationCount: show("total_donations") ? explicit : null,
      joinedAt: user.created_at,
      totalCallsMade: user.total_calls_made,
      totalCallsReceived: user.total_calls_received,
      donorsManagedCount: user.donors_managed_count,
      publicProfileView: user.public_profile_view || "tabs",
    },
  });
}

