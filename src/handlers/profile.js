import { ok, err, readJson, isValidBloodGroup, isValidUsernameSlug, genRandomSlug, nowIso } from "../lib/util.js";
import { getSettings, settingBool } from "../lib/settings.js";
import { getCurrentUser, clearSessionCookie } from "../lib/authctx.js";
import { logActivity } from "../lib/activity.js";
import { donorbdCheckAvailability, donorbdNewEntry, donorbdDeleteEntry } from "../lib/donorbd.js";
import { uploadToImgbb } from "../lib/imgbb.js";

const DEFAULT_VISIBILITY = {
  mobile: "patients_only",
  address_summary: "patients_only",
  location: "patients_only",
  last_donation_date: "public",
  total_donations: "public",
  donation_history_tab: "public",
  call_history_tab: "public",
};
const ALWAYS_PUBLIC = ["name", "username", "note"];
const VISIBILITY_VALUES = ["public", "patients_only", "hidden"];

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
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
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
      totalDonations,
      totalCallsMade: user.total_calls_made,
      totalCallsReceived: user.total_calls_received,
      donorsManagedCount: user.donors_managed_count,
      createdAt: user.created_at,
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
    values.push(body.note.slice(0, 300));
  }

  // Profile picture upload (base64 image data sent from client)
  if (body.profilePicBase64) {
    const settings = await getSettings(env.DB);
    try {
      const { url, deleteUrl } = await uploadToImgbb(settings.imgbb_api_key, body.profilePicBase64);
      fields.push("profile_pic_url = ?", "profile_pic_delete_url = ?");
      values.push(url, deleteUrl);
    } catch (e) {
      return err(String(e.message || e));
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

  const settings = await getSettings(env.DB);
  const waitMonths = parseInt(settings.eligibility_wait_months || "3", 10);
  let eligibilityStatus = "on";
  let snoozeUntil = null;
  if (body.lastDonationDate && waitMonths > 0) {
    const until = new Date(body.lastDonationDate);
    until.setMonth(until.getMonth() + waitMonths);
    if (until.getTime() > Date.now()) {
      eligibilityStatus = "snoozed";
      snoozeUntil = until.toISOString().replace("T", " ").slice(0, 19);
    }
  }

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

  const settings = await getSettings(env.DB);
  const localTaken = await env.DB
    .prepare("SELECT id FROM users WHERE LOWER(username_slug) = LOWER(?) AND id != ?")
    .bind(slug, user.id)
    .first();
  if (localTaken) return err("এই ইউজারনেইম ইতিমধ্যে ব্যবহৃত হচ্ছে");

  const checkRequired = settingBool(settings, "donorbd_check_before_claim", true);
  if (checkRequired) {
    const remote = await donorbdCheckAvailability(settings, slug.toLowerCase());
    if (remote.configured && !remote.available) return err("এই ইউজারনেইম donor.bd তে উপলব্ধ নয়");
  }

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
  const incoming = body.visibility || {};
  const current = { ...DEFAULT_VISIBILITY, ...safeJson(user.visibility_json) };
  for (const [k, v] of Object.entries(incoming)) {
    if (ALWAYS_PUBLIC.includes(k)) continue;
    if (VISIBILITY_VALUES.includes(v)) current[k] = v;
  }
  await env.DB.prepare("UPDATE users SET visibility_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(current), nowIso(), user.id).run();
  return ok({ visibility: current });
}

export async function handleDonationsList(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const { results } = await env.DB
    .prepare("SELECT id, hospital_name, donation_date FROM donations WHERE user_id = ? ORDER BY donation_date DESC")
    .bind(user.id)
    .all();
  return ok({ donations: results, extraCount: user.extra_donation_count || 0 });
}

export async function handleDonationsAdd(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const date = body.date;
  const hospitalName = body.hospitalName || null;
  const countAsExtra = !!body.countAsAdditionalExtra; // default false per spec
  if (!date) return err("তারিখ দিন");

  await env.DB
    .prepare("INSERT INTO donations (user_id, hospital_name, donation_date, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, hospitalName, date, nowIso())
    .run();
  if (countAsExtra) {
    await env.DB.prepare("UPDATE users SET extra_donation_count = extra_donation_count + 1 WHERE id = ?").bind(user.id).run();
  }
  await env.DB.prepare("UPDATE users SET last_donation_date = ?, updated_at = ? WHERE id = ? AND (last_donation_date IS NULL OR last_donation_date < ?)")
    .bind(date, nowIso(), user.id, date)
    .run();
  await logActivity(env.DB, { actorUser: user, category: "donation", actionText: `পূর্বের রক্তদানের তথ্য যোগ করেছেন (${date})` });
  return ok({ added: true });
}

export async function handleDonationsBulkAdd(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const count = parseInt(body.count, 10);
  if (!Number.isFinite(count) || count < 0 || count > 500) return err("সঠিক সংখ্যা দিন");
  await env.DB.prepare("UPDATE users SET extra_donation_count = ?, updated_at = ? WHERE id = ?").bind(count, nowIso(), user.id).run();
  await logActivity(env.DB, { actorUser: user, category: "donation", actionText: `অতিরিক্ত রক্তদানের সংখ্যা সেট করেছেন (${count})` });
  return ok({ extraCount: count });
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

export async function handlePublicProfile(request, env, slug) {
  const user = await env.DB.prepare("SELECT * FROM users WHERE LOWER(username_slug) = LOWER(?) AND deleted = 0").bind(slug).first();
  if (!user) return err("প্রোফাইল পাওয়া যায়নি", 404);
  const viewer = await getCurrentUser(request, env);
  const vis = { ...DEFAULT_VISIBILITY, ...safeJson(user.visibility_json) };
  const explicit = await donationCount(env.DB, user.id);
  const totalDonations = explicit + (user.extra_donation_count || 0);
  const location = user.location_id ? await env.DB.prepare("SELECT name FROM locations WHERE id = ?").bind(user.location_id).first() : null;

  const isSelf = viewer && viewer.id === user.id;
  const show = (field) => isSelf || vis[field] === "public" || (vis[field] === "patients_only" && viewer);

  return ok({
    profile: {
      name: user.name,
      username: user.username_display,
      profilePicUrl: user.profile_pic_url,
      isDonor: !!user.is_donor,
      bloodGroup: user.blood_group,
      note: user.donor_note,
      totalDonations,
      lastDonationDate: show("last_donation_date") ? user.last_donation_date : null,
      addressSummary: show("address_summary") ? user.address_summary : null,
      locationName: show("location") && location ? location.name : null,
      mobile: show("mobile") ? user.mobile : null,
      donationHistoryVisible: vis.donation_history_tab !== "hidden" || isSelf,
      callHistoryVisible: vis.call_history_tab !== "hidden" || isSelf,
      joinedAt: user.created_at,
      totalCallsMade: user.total_calls_made,
      totalCallsReceived: user.total_calls_received,
      donorsManagedCount: user.donors_managed_count,
    },
  });
}
