import { ok, err, readJson, isValidBdMobile, isValidBloodGroup, isValidUsernameSlug, hashPassword, nowIso, getReservedSlugSet } from "../lib/util.js";
import { genAndClaimRandomSlug, claimUnregisteredDonorbdSlugs } from "../lib/donorbd.js";
import { getSettings, setSettings, settingInt } from "../lib/settings.js";
import { getCurrentUser } from "../lib/authctx.js";
import { hasPermission, isAnyAdmin, PERMISSIONS } from "../lib/permissions.js";
import { logActivity } from "../lib/activity.js";
import { getMe, setWebhook, deleteWebhook, deleteMessage } from "../lib/telegramApi.js";

async function requirePerm(request, env, permKey) {
  const user = await getCurrentUser(request, env);
  if (!user) return { user: null, resp: err("লগইন প্রয়োজন", 401) };
  if (!isAnyAdmin(user)) return { user: null, resp: err("অ্যাডমিন অ্যাক্সেস প্রয়োজন", 403) };
  if (permKey && !hasPermission(user, permKey)) return { user: null, resp: err("এই অংশে আপনার অনুমতি নেই", 403) };
  return { user, resp: null };
}

// ---------------------------------------------------------------- ANALYTICS
export async function handleAnalytics(request, env) {
  const { resp } = await requirePerm(request, env, null); // any admin can view dashboard
  if (resp) return resp;

  const db = env.DB;
  const totalUsers = (await db.prepare("SELECT COUNT(*) c FROM users WHERE deleted = 0").first()).c;
  const totalDonors = (await db.prepare("SELECT COUNT(*) c FROM users WHERE deleted = 0 AND is_donor = 1").first()).c;
  const totalAvailable = (await db.prepare("SELECT COUNT(*) c FROM users WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'on'").first()).c;

  // Every calls query below joins back to users on both sides and
  // excludes deleted = 1 requesters/donors, so a deleted account's call
  // history stops contributing to these numbers instead of lingering in
  // the calls table (rows there are never deleted when an account is,
  // per handleDeleteUser - only the users row is soft-deleted).
  const totalCallsMade = (await db
    .prepare(
      `SELECT COUNT(*) c FROM calls c
       JOIN users req ON req.id = c.requester_id AND req.deleted = 0
       JOIN users don ON don.id = c.donor_id AND don.deleted = 0`
    )
    .first()).c;
  const totalManaged = (await db
    .prepare(
      `SELECT COUNT(*) c FROM calls c
       JOIN users req ON req.id = c.requester_id AND req.deleted = 0
       JOIN users don ON don.id = c.donor_id AND don.deleted = 0
       WHERE c.status = 'can_donate'`
    )
    .first()).c;
  const totalCallsReceived = totalCallsMade;

  // "কল স্ট্যাটাস আপডেট করা হয়েছে" - every call row starts as 'pending' the
  // moment a donor is shown/locked to a requester (see seek.js's INSERT)
  // and only moves to a real status once the requester reports back, so
  // != 'pending' is exactly "an outcome was actually recorded for this call".
  const totalStatusUpdated = (await db
    .prepare(
      `SELECT COUNT(*) c FROM calls c
       JOIN users req ON req.id = c.requester_id AND req.deleted = 0
       JOIN users don ON don.id = c.donor_id AND don.deleted = 0
       WHERE c.status != 'pending'`
    )
    .first()).c;

  // "মোট সিকার" - distinct people who have made at least one seek request
  // (appear as a requester on any call row), not the same as totalUsers.
  const totalSeekers = (await db
    .prepare(
      `SELECT COUNT(DISTINCT c.requester_id) c FROM calls c
       JOIN users req ON req.id = c.requester_id AND req.deleted = 0`
    )
    .first()).c;

  // The four eligibility sub-states below all correspond to donor rows,
  // split by eligibility_status/last_donation_date/snooze_reason - see the
  // eligibility_status column comment in schema.sql ('on' | 'snoozed' |
  // 'off') and donor.js's handleDonorEligibility, which is the only place
  // eligibility_snooze_reason values are set. 'সাম্প্রতিক রক্তদান' is the
  // one reason string used exclusively for the automatic post-donation
  // wait window (see donor.js's handleLogDonation) - every other snoozed
  // reason ("আজকের জন্য বন্ধ", "২ ঘন্টার জন্য স্থগিত", etc) is a donor's own
  // deliberate temporary pause that the scheduled sweep wakes automatically.
  const totalOffNoDonation = (await db
    .prepare("SELECT COUNT(*) c FROM users WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'off' AND last_donation_date IS NULL")
    .first()).c;
  const totalOffPastWait = (await db
    .prepare("SELECT COUNT(*) c FROM users WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'off' AND last_donation_date IS NOT NULL")
    .first()).c;
  const totalWaitingAfterDonation = (await db
    .prepare("SELECT COUNT(*) c FROM users WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'snoozed' AND eligibility_snooze_reason = 'সাম্প্রতিক রক্তদান'")
    .first()).c;
  const totalSnoozed = (await db
    .prepare("SELECT COUNT(*) c FROM users WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'snoozed' AND (eligibility_snooze_reason IS NULL OR eligibility_snooze_reason != 'সাম্প্রতিক রক্তদান')")
    .first()).c;

  const byGroup = await db
    .prepare(
      `SELECT blood_group, COUNT(*) as total, SUM(CASE WHEN eligibility_status='on' THEN 1 ELSE 0 END) as eligible
       FROM users WHERE deleted = 0 AND is_donor = 1 AND blood_group IS NOT NULL GROUP BY blood_group`
    )
    .all();

  const byCallStatus = await db
    .prepare(
      `SELECT c.status, COUNT(*) as total FROM calls c
       JOIN users req ON req.id = c.requester_id AND req.deleted = 0
       JOIN users don ON don.id = c.donor_id AND don.deleted = 0
       GROUP BY c.status`
    )
    .all();

  return ok({
    totalUsers,
    totalDonors,
    totalAvailable,
    totalCallsMade,
    totalManaged,
    totalCallsReceived,
    totalSnoozed,
    totalStatusUpdated,
    totalSeekers,
    totalOffNoDonation,
    totalOffPastWait,
    totalWaitingAfterDonation,
    byGroup: byGroup.results,
    byCallStatus: byCallStatus.results,
  });
}

// -------------------------------------------------------------------- USERS
export async function handleUsersList(request, env) {
  const { resp } = await requirePerm(request, env, "manage_users");
  if (resp) return resp;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const perPage = 50;
  const offset = (page - 1) * perPage;

  let query = "SELECT id, mobile, name, username_display, is_admin, is_root_admin, is_donor, blood_group, eligibility_status, disabled, must_change_password, created_at FROM users WHERE deleted = 0";
  const binds = [];
  if (q) {
    query += " AND (mobile LIKE ? OR name LIKE ? OR username_display LIKE ?)";
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  query += " ORDER BY id DESC LIMIT ? OFFSET ?";
  binds.push(perPage, offset);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return ok({ users: results, page });
}

export async function handleUserCreate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_users");
  if (resp) return resp;
  const body = await readJson(request);
  const mobile = (body.mobile || "").trim();
  if (!isValidBdMobile(mobile)) return err("সঠিক মোবাইল নাম্বার দিন");
  const password = body.password || Math.random().toString(36).slice(2, 10);
  if (password.length < 4) return err("পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে");
  const existing = await env.DB.prepare("SELECT id FROM users WHERE mobile = ? AND deleted = 0").bind(mobile).first();
  if (existing) return err("এই মোবাইল নাম্বার ইতিমধ্যে ব্যবহৃত হচ্ছে");

  const passwordHash = await hashPassword(password);
  const mustChange = body.requireChangeOnLogin ? 1 : 0;
  const settings = await getSettings(env.DB);
  const baseUrl = new URL(request.url).origin;
  const { slug: randomSlug, donorbdRegistered } = await genAndClaimRandomSlug(env.DB, settings, baseUrl);
  const res = await env.DB
    .prepare(
      "INSERT INTO users (mobile, password_hash, name, is_donor, blood_group, must_change_password, username_slug, username_display, donorbd_slug_registered, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(mobile, passwordHash, body.name || null, body.isDonor ? 1 : 0, isValidBloodGroup(body.bloodGroup) ? body.bloodGroup : null, mustChange, randomSlug.toLowerCase(), randomSlug, donorbdRegistered ? 1 : 0, nowIso(), nowIso())
    .run();

  const { sendNotificationSms, fillTemplate } = await import("../lib/sms.js");
  const msg = fillTemplate(settings.sms_account_created_import, { password }, settings);
  await sendNotificationSms(env.DB, settings, mobile, msg, "account_created_import");

  await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `নতুন ইউজার তৈরি করেছেন: ${mobile}` });
  return ok({ id: res.meta.last_row_id, generatedPassword: body.password ? null : password });
}

export async function handleUserUpdate(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_users");
  if (resp) return resp;
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").bind(id).first();
  if (!target) return err("ইউজার পাওয়া যায়নি", 404);
  if (target.is_root_admin && !admin.is_root_admin) return err("রুট অ্যাডমিন পরিবর্তন করার অনুমতি নেই", 403);

  const body = await readJson(request);
  const fields = [];
  const values = [];
  if (typeof body.name === "string") { fields.push("name = ?"); values.push(body.name); }
  if (body.bloodGroup !== undefined) { fields.push("blood_group = ?"); values.push(body.bloodGroup || null); }
  if (body.isDonor !== undefined) { fields.push("is_donor = ?"); values.push(body.isDonor ? 1 : 0); }
  if (body.isAdmin !== undefined && !target.is_root_admin) { fields.push("is_admin = ?"); values.push(body.isAdmin ? 1 : 0); }
  if (body.permissions !== undefined && !target.is_root_admin) {
    const valid = body.permissions.filter((p) => PERMISSIONS.some((x) => x.key === p));
    fields.push("permissions_json = ?");
    values.push(JSON.stringify(valid));
  }
  // Admin editing username: same reserved-word + uniqueness rules as a
  // donor claiming their own, so an admin can't accidentally hand out a
  // reserved app path either.
  if (typeof body.username === "string" && body.username.trim()) {
    const slug = body.username.trim();
    if (!isValidUsernameSlug(slug)) return err("ইউজারনেইম অবৈধ (৩-৩২ অক্ষর, শুধু a-z, 0-9, _, -)");
    const reserved = await getReservedSlugSet(env.DB);
    if (reserved.has(slug.toLowerCase())) return err("এই ইউজারনেইমটি ব্যবহার করা যাচ্ছে না");
    const taken = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username_slug) = LOWER(?) AND id != ?").bind(slug, id).first();
    if (taken) return err("এই ইউজারনেইম ইতিমধ্যে ব্যবহৃত হচ্ছে");
    fields.push("username_slug = ?", "username_display = ?");
    values.push(slug.toLowerCase(), slug);
  }
  // Admin editing mobile: same uniqueness rule mobile always has.
  if (typeof body.mobile === "string" && body.mobile.trim() && body.mobile.trim() !== target.mobile) {
    const mobile = body.mobile.trim();
    if (!isValidBdMobile(mobile)) return err("সঠিক মোবাইল নাম্বার দিন");
    const taken = await env.DB.prepare("SELECT id FROM users WHERE mobile = ? AND id != ?").bind(mobile, id).first();
    if (taken) return err("এই মোবাইল নাম্বার ইতিমধ্যে ব্যবহৃত হচ্ছে");
    fields.push("mobile = ?");
    values.push(mobile);
  }
  // Availability/eligibility - admin override. Setting to "on" or "off"
  // clears any snooze; "snoozed" without a date defaults to the site's
  // eligibility wait timeline, same as a normal call-triggered snooze.
  if (body.eligibilityStatus === "on" || body.eligibilityStatus === "off") {
    fields.push("eligibility_status = ?", "eligibility_snooze_until = ?", "eligibility_snooze_reason = ?");
    values.push(body.eligibilityStatus, null, null);
  } else if (body.eligibilityStatus === "snoozed") {
    const settings = await getSettings(env.DB);
    const waitMonths = settingInt(settings, "eligibility_wait_months", 3);
    const until = new Date();
    until.setMonth(until.getMonth() + Math.max(1, waitMonths || 3));
    fields.push("eligibility_status = ?", "eligibility_snooze_until = ?", "eligibility_snooze_reason = ?");
    values.push("snoozed", until.toISOString().replace("T", " ").slice(0, 19), "এডমিন কর্তৃক স্থগিত");
  }
  if (body.disabled !== undefined && !target.is_root_admin) { fields.push("disabled = ?"); values.push(body.disabled ? 1 : 0); }
  if (!fields.length) return err("কোনো পরিবর্তন পাওয়া যায়নি");
  fields.push("updated_at = ?");
  values.push(nowIso(), id);
  await env.DB.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `ইউজার তথ্য আপডেট করেছেন: ${target.mobile}` });
  return ok({ updated: true });
}

export async function handleUserDelete(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_users");
  if (resp) return resp;
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!target) return err("ইউজার পাওয়া যায়নি", 404);
  if (target.is_root_admin) return err("রুট অ্যাডমিন ডিলিট করা যাবে না", 403);
  // Soft-delete keeps the row (for activity-log/call-history references) but
  // frees up the mobile number for reuse - mobile is UNIQUE, so without
  // this a deleted account permanently blocks anyone (including the same
  // person) from ever signing up again with that number, which is exactly
  // the "UNIQUE constraint failed" bug reported. The freed value keeps the
  // original number readable for admin/audit purposes via a suffix rather
  // than discarding it outright.
  const freedMobile = `deleted_${target.id}`;
  await env.DB.prepare("UPDATE users SET deleted = 1, mobile = ?, username_slug = NULL, updated_at = ? WHERE id = ?").bind(freedMobile, nowIso(), id).run();
  await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `ইউজার ডিলিট করেছেন: ${target.mobile}` });
  return ok({ deleted: true });
}

export async function handleUserBulkAction(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_users");
  if (resp) return resp;
  const body = await readJson(request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((n) => Number.isInteger(n)) : [];
  const action = body.action; // delete | enable | disable | reset_password
  if (!ids.length) return err("কোনো ইউজার নির্বাচন করা হয়নি");
  const placeholders = ids.map(() => "?").join(",");
  let generatedPassword = null;

  if (action === "delete") {
    // Same mobile-freeing rationale as handleUserDelete above - done as a
    // per-row UPDATE (not a single bulk UPDATE) since each row needs its
    // own unique freed-mobile suffix.
    const { results: targets } = await env.DB
      .prepare(`SELECT id, mobile FROM users WHERE id IN (${placeholders}) AND is_root_admin = 0`)
      .bind(...ids)
      .all();
    for (const t of targets) {
      await env.DB
        .prepare("UPDATE users SET deleted = 1, mobile = ?, username_slug = NULL, updated_at = ? WHERE id = ?")
        .bind(`deleted_${t.id}`, nowIso(), t.id)
        .run();
    }
  } else if (action === "enable") {
    await env.DB.prepare(`UPDATE users SET disabled = 0, updated_at = ? WHERE id IN (${placeholders})`).bind(nowIso(), ...ids).run();
  } else if (action === "disable") {
    await env.DB.prepare(`UPDATE users SET disabled = 1, updated_at = ? WHERE id IN (${placeholders}) AND is_root_admin = 0`).bind(nowIso(), ...ids).run();
  } else if (action === "reset_password") {
    const manualPassword = (body.newPassword || "").trim();
    const newPassword = manualPassword || Math.random().toString(36).slice(2, 10);
    if (newPassword.length < 4) return err("পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে");
    generatedPassword = manualPassword ? null : newPassword; // only surface it back to the admin when it was auto-generated

    const passwordHash = await hashPassword(newPassword);
    await env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id IN (${placeholders})`).bind(passwordHash, nowIso(), ...ids).run();

    // Inform each affected account holder by SMS so a password reset never
    // happens silently from their point of view.
    const settings = await getSettings(env.DB);
    const { sendNotificationSms, fillTemplate } = await import("../lib/sms.js");
    const { results: targets } = await env.DB.prepare(`SELECT mobile FROM users WHERE id IN (${placeholders})`).bind(...ids).all();
    const msg = fillTemplate(settings.sms_password_reset_by_admin, { password: newPassword }, settings);
    for (const t of targets) {
      await sendNotificationSms(env.DB, settings, t.mobile, msg, "password_reset");
    }
  } else {
    return err("Invalid action");
  }
  await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `বাল্ক একশন (${action}) প্রয়োগ করেছেন ${ids.length} জন ইউজারে` });
  return ok({ applied: true, count: ids.length, generatedPassword });
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

export async function handleUsersImport(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_users");
  if (resp) return resp;
  const body = await readJson(request);
  const csvText = body.csv || "";
  const requireChangeOnLogin = !!body.requireChangeOnLogin; // disabled by default
  const rows = parseCsv(csvText);
  let created = 0;
  const errors = [];
  const settings = await getSettings(env.DB);
  const { sendNotificationSms, fillTemplate } = await import("../lib/sms.js");
  const baseUrl = new URL(request.url).origin;

  for (const row of rows) {
    const mobile = (row.mobile || "").trim();
    if (!isValidBdMobile(mobile)) { errors.push(`${mobile || "(খালি)"}: অবৈধ মোবাইল`); continue; }
    const existing = await env.DB.prepare("SELECT id FROM users WHERE mobile = ? AND deleted = 0").bind(mobile).first();
    if (existing) { errors.push(`${mobile}: ইতিমধ্যে আছে`); continue; }
    const password = row.password || Math.random().toString(36).slice(2, 10);
    const passwordHash = await hashPassword(password);
    const { slug: randomSlug, donorbdRegistered } = await genAndClaimRandomSlug(env.DB, settings, baseUrl);
    await env.DB
      .prepare(
        "INSERT INTO users (mobile, password_hash, name, blood_group, is_donor, must_change_password, username_slug, username_display, donorbd_slug_registered, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(mobile, passwordHash, row.name || null, isValidBloodGroup(row.bloodGroup) ? row.bloodGroup : null, row.isDonor === "1" || row.isDonor === "true" ? 1 : 0, requireChangeOnLogin ? 1 : 0, randomSlug.toLowerCase(), randomSlug, donorbdRegistered ? 1 : 0, nowIso(), nowIso())
      .run();
    const msg = fillTemplate(settings.sms_account_created_import, { password }, settings);
    await sendNotificationSms(env.DB, settings, mobile, msg, "account_created_import");
    created++;
  }

  await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `CSV ইম্পোর্ট: ${created} জন ইউজার তৈরি হয়েছে` });
  return ok({ created, errors });
}

export async function handleUsersExport(request, env) {
  const { resp } = await requirePerm(request, env, "manage_users");
  if (resp) return resp;
  const { results } = await env.DB
    .prepare("SELECT mobile, name, username_display, blood_group, is_donor, is_admin, disabled, created_at FROM users WHERE deleted = 0 ORDER BY id ASC")
    .all();
  const headers = ["mobile", "name", "username", "bloodGroup", "isDonor", "isAdmin", "disabled", "createdAt"];
  const lines = [headers.join(",")];
  for (const r of results) {
    lines.push(
      [r.mobile, r.name || "", r.username_display || "", r.blood_group || "", r.is_donor, r.is_admin, r.disabled, r.created_at]
        .map((v) => String(v).replace(/,/g, " "))
        .join(",")
    );
  }
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=users_export.csv" },
  });
}

// ------------------------------------------------------------- SMS SETTINGS
export async function handleSmsSettingsGet(request, env) {
  const { resp } = await requirePerm(request, env, "manage_sms_settings");
  if (resp) return resp;
  const settings = await getSettings(env.DB);
  return ok({
    sms_account_created_self: settings.sms_account_created_self,
    sms_account_created_import: settings.sms_account_created_import,
    sms_otp: settings.sms_otp,
    sms_password_reset_by_admin: settings.sms_password_reset_by_admin,
    sms_eligibility_change_by_call: settings.sms_eligibility_change_by_call,
    sms_donation_reminder: settings.sms_donation_reminder,
    sms_eligibility_reopened: settings.sms_eligibility_reopened,
    otp_test_mode: settings.otp_test_mode === "1",
    manual_otp: settings.manual_otp,
    greensms_api_key: settings.greensms_api_key,
    sms_enabled_account_created_self: settings.sms_enabled_account_created_self !== "0",
    sms_enabled_account_created_import: settings.sms_enabled_account_created_import !== "0",
    sms_enabled_otp: settings.sms_enabled_otp !== "0",
    sms_enabled_password_reset: settings.sms_enabled_password_reset !== "0",
    sms_enabled_eligibility_change_by_call: settings.sms_enabled_eligibility_change_by_call !== "0",
    sms_enabled_donation_reminder: settings.sms_enabled_donation_reminder !== "0",
    sms_enabled_eligibility_reopened: settings.sms_enabled_eligibility_reopened !== "0",
    sms_daily_limit_user_initiated: settings.sms_daily_limit_user_initiated || "3",
    sms_daily_limit_system: settings.sms_daily_limit_system || "3",
    sms_over_limit_otp_message: settings.sms_over_limit_otp_message || "আপনার দৈনিক এসএমএস লিমিট শেষ হয়েছে। 01883-600680 নাম্বারে কল করুন",
  });
}

export async function handleSmsSettingsUpdate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_sms_settings");
  if (resp) return resp;
  const body = await readJson(request);
  const allowed = ["sms_account_created_self", "sms_account_created_import", "sms_otp", "sms_password_reset_by_admin", "sms_eligibility_change_by_call", "sms_donation_reminder", "sms_eligibility_reopened", "manual_otp", "greensms_api_key", "sms_over_limit_otp_message"];
  const patch = {};
  for (const k of allowed) if (typeof body[k] === "string") patch[k] = body[k];
  if (body.otp_test_mode !== undefined) patch.otp_test_mode = body.otp_test_mode ? "1" : "0";
  for (const k of ["sms_enabled_account_created_self", "sms_enabled_account_created_import", "sms_enabled_otp", "sms_enabled_password_reset", "sms_enabled_eligibility_change_by_call", "sms_enabled_donation_reminder", "sms_enabled_eligibility_reopened"]) {
    if (body[k] !== undefined) patch[k] = body[k] ? "1" : "0";
  }
  if (body.sms_daily_limit_user_initiated !== undefined) patch.sms_daily_limit_user_initiated = String(Math.max(0, parseInt(body.sms_daily_limit_user_initiated, 10) || 0));
  if (body.sms_daily_limit_system !== undefined) patch.sms_daily_limit_system = String(Math.max(0, parseInt(body.sms_daily_limit_system, 10) || 0));
  await setSettings(env.DB, patch);
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: "এসএমএস সেটিংস আপডেট করেছেন" });
  return ok({ updated: true });
}

const SMS_TEMPLATE_KEYS = ["sms_account_created_self", "sms_account_created_import", "sms_otp", "sms_password_reset_by_admin", "sms_eligibility_change_by_call", "sms_donation_reminder", "sms_eligibility_reopened"];

export async function handleSmsTest(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_sms_settings");
  if (resp) return resp;
  const body = await readJson(request);
  const mobile = (body.mobile || "").trim();
  if (!isValidBdMobile(mobile)) return err("সঠিক মোবাইল নাম্বার দিন");
  if (!SMS_TEMPLATE_KEYS.includes(body.templateKey)) return err("সঠিক টেমপ্লেট নির্বাচন করুন");

  const settings = await getSettings(env.DB);
  const { sendNotificationSms, fillTemplate } = await import("../lib/sms.js");
  const sample = {
    siteTitle: settings.site_title || "BloodNet v2",
    password: "test1234",
    otp: "123456",
    status: "রক্ত দিতে পারবে না (দূরে আছেন)",
  };
  const message = fillTemplate(settings[body.templateKey], sample, settings);
  // Test sends intentionally bypass the per-type on/off toggle (no typeKey
  // passed) so an admin can verify the gateway even while a category is
  // switched off for real traffic.
  const result = await sendNotificationSms(env.DB, settings, mobile, message);
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `টেস্ট এসএমএস পাঠিয়েছেন: ${mobile} (${body.templateKey})` });
  if (!result.sent) return err(`পাঠানো যায়নি: ${result.reason || "unknown"}`);
  return ok({ sent: true, message, gatewayResponse: result.raw || null });
}

// ------------------------------------------------------------- SITE APIS
export async function handleSiteApisGet(request, env) {
  const { resp } = await requirePerm(request, env, "manage_site_apis");
  if (resp) return resp;
  const settings = await getSettings(env.DB);
  return ok({
    imgbb_api_key: settings.imgbb_api_key,
    donorbd_api_key: settings.donorbd_api_key,
    donorbd_base_url: settings.donorbd_base_url,
    donorbd_check_before_claim: settings.donorbd_check_before_claim === "1",
  });
}

export async function handleSiteApisUpdate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_site_apis");
  if (resp) return resp;
  const body = await readJson(request);
  const patch = {};
  for (const k of ["imgbb_api_key", "donorbd_api_key", "donorbd_base_url"]) {
    if (typeof body[k] === "string") patch[k] = body[k];
  }
  if (body.donorbd_check_before_claim !== undefined) patch.donorbd_check_before_claim = body.donorbd_check_before_claim ? "1" : "0";
  await setSettings(env.DB, patch);
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: "সাইট এপিআই সেটিংস আপডেট করেছেন" });
  return ok({ updated: true });
}

// ------------------------------------------------------------- LOCATIONS
export async function handleLocationsList(request, env) {
  const user = await getCurrentUser(request, env);
  // Public read (needed for signup/profile forms); write is permission-gated below.
  const { results } = await env.DB.prepare("SELECT * FROM locations ORDER BY parent_id IS NOT NULL, sort_order ASC, name ASC").all();
  return ok({ locations: results });
}

export async function handleLocationCreate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_locations");
  if (resp) return resp;
  const body = await readJson(request);
  if (!body.name) return err("নাম দিন");
  const res = await env.DB.prepare("INSERT INTO locations (parent_id, name, sort_order) VALUES (?, ?, ?)").bind(body.parentId || null, body.name, body.sortOrder || 0).run();
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `লোকেশন যোগ করেছেন: ${body.name}` });
  return ok({ id: res.meta.last_row_id });
}

export async function handleLocationUpdate(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_locations");
  if (resp) return resp;
  const body = await readJson(request);
  await env.DB.prepare("UPDATE locations SET name = ?, parent_id = ?, sort_order = ? WHERE id = ?").bind(body.name, body.parentId || null, body.sortOrder || 0, id).run();
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `লোকেশন আপডেট করেছেন (id ${id})` });
  return ok({ updated: true });
}

export async function handleLocationDelete(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_locations");
  if (resp) return resp;
  await env.DB.prepare("DELETE FROM locations WHERE id = ?").bind(id).run();
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `লোকেশন ডিলিট করেছেন (id ${id})` });
  return ok({ deleted: true });
}

// ------------------------------------------------------- EXTERNAL SOURCES
export async function handleExtSourcesList(request, env) {
  const { results } = await env.DB.prepare("SELECT * FROM external_sources ORDER BY sort_order ASC").all();
  return ok({ sources: results });
}

export async function handleExtSourceCreate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_external_sources");
  if (resp) return resp;
  const body = await readJson(request);
  if (!body.name || !body.url) return err("নাম এবং URL দিন");
  const res = await env.DB.prepare("INSERT INTO external_sources (name, url, sort_order) VALUES (?, ?, ?)").bind(body.name, body.url, body.sortOrder || 0).run();
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `এক্সটার্নাল সোর্স যোগ করেছেন: ${body.name}` });
  return ok({ id: res.meta.last_row_id });
}

export async function handleExtSourceUpdate(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_external_sources");
  if (resp) return resp;
  const body = await readJson(request);
  await env.DB.prepare("UPDATE external_sources SET name = ?, url = ?, sort_order = ? WHERE id = ?").bind(body.name, body.url, body.sortOrder || 0, id).run();
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `এক্সটার্নাল সোর্স আপডেট করেছেন (id ${id})` });
  return ok({ updated: true });
}

export async function handleExtSourceDelete(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_external_sources");
  if (resp) return resp;
  await env.DB.prepare("DELETE FROM external_sources WHERE id = ?").bind(id).run();
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `এক্সটার্নাল সোর্স ডিলিট করেছেন (id ${id})` });
  return ok({ deleted: true });
}

// --------------------------------------------------------- SITE SETTINGS
export async function handleSiteSettingsGet(request, env) {
  const { resp } = await requirePerm(request, env, "manage_site_settings");
  if (resp) return resp;
  const settings = await getSettings(env.DB);
  return ok({
    site_title: settings.site_title,
    logo_url: settings.logo_url,
    favicon_url: settings.favicon_url,
    social_preview_url: settings.social_preview_url,
    theme_color: settings.theme_color,
    welcome_heading: settings.welcome_heading,
    welcome_subheading: settings.welcome_subheading,
    welcome_small_text: settings.welcome_small_text,
    eligibility_wait_months: settings.eligibility_wait_months,
    eligibility_reopen_delay_days: settings.eligibility_reopen_delay_days || "15",
    eligibility_reopen_repeat_days: settings.eligibility_reopen_repeat_days || "15",
    self_deletion_enabled: settings.self_deletion_enabled === "1",
    session_days: settings.session_days || "90",
    show_seek_option: settings.show_seek_option !== "0",
    show_join_option: settings.show_join_option !== "0",
    show_logout_button: settings.show_logout_button === "1",
    profile_share_base_url: settings.profile_share_base_url || "",
    default_avatars_json: settings.default_avatars_json || "[]",
    whatsapp_seek_message: settings.whatsapp_seek_message || "আসসালামুআলাইকুম। আশা করি ভালো আছেন। {bloodGroup} রক্তদাতা খুঁজছিলাম। আপনি কি এভেইলেবল আছেন?",
    // moved here from Site APIs - these govern the /seek system, not third-party credentials
    otp_required_for_number_change: settings.otp_required_for_number_change !== "0",
    call_limit_count: settings.call_limit_count,
    call_limit_minutes: settings.call_limit_minutes,
    donor_lock_minutes: settings.donor_lock_minutes,
    call_status_timer_seconds: settings.call_status_timer_seconds || "20",
    mask_visible_digits: settings.mask_visible_digits || "4",
    reserved_usernames: settings.reserved_usernames || "",
  });
}

export async function handleSiteSettingsUpdate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_site_settings");
  if (resp) return resp;
  const body = await readJson(request);
  const patch = {};
  for (const k of ["site_title", "logo_url", "favicon_url", "social_preview_url", "theme_color", "welcome_heading", "welcome_subheading", "welcome_small_text", "profile_share_base_url", "default_avatars_json", "reserved_usernames", "whatsapp_seek_message"]) {
    if (typeof body[k] === "string") patch[k] = body[k];
  }
  if (body.eligibility_wait_months !== undefined) patch.eligibility_wait_months = String(parseInt(body.eligibility_wait_months, 10) || 0);
  if (body.eligibility_reopen_delay_days !== undefined) patch.eligibility_reopen_delay_days = String(Math.max(0, parseInt(body.eligibility_reopen_delay_days, 10) || 0));
  if (body.eligibility_reopen_repeat_days !== undefined) patch.eligibility_reopen_repeat_days = String(Math.max(0, parseInt(body.eligibility_reopen_repeat_days, 10) || 0));
  if (body.self_deletion_enabled !== undefined) patch.self_deletion_enabled = body.self_deletion_enabled ? "1" : "0";
  if (body.session_days !== undefined) patch.session_days = String(Math.max(1, parseInt(body.session_days, 10) || 90));
  if (body.show_seek_option !== undefined) patch.show_seek_option = body.show_seek_option ? "1" : "0";
  if (body.show_join_option !== undefined) patch.show_join_option = body.show_join_option ? "1" : "0";
  if (body.show_logout_button !== undefined) patch.show_logout_button = body.show_logout_button ? "1" : "0";
  if (body.otp_required_for_number_change !== undefined) patch.otp_required_for_number_change = body.otp_required_for_number_change ? "1" : "0";
  for (const k of ["call_limit_count", "call_limit_minutes", "donor_lock_minutes", "call_status_timer_seconds"]) {
    if (body[k] !== undefined) patch[k] = String(Math.max(1, parseInt(body[k], 10) || 1));
  }
  if (body.mask_visible_digits !== undefined) {
    const digits = Math.max(2, Math.min(8, parseInt(body.mask_visible_digits, 10) || 4));
    patch.mask_visible_digits = String(digits);
  }
  await setSettings(env.DB, patch);
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: "সাইট সেটিংস আপডেট করেছেন" });
  return ok({ updated: true });
}

// -------------------------------------------------------- PUBLIC SETTINGS
// Looks up a per-domain branding override (see মাল্টিসাইট ব্র্যান্ডিং section
// below) for the given hostname, if the feature is turned on and a row
// matches. Returns null when multisite branding is off or no domain
// matches, in which case callers should fall back to the site-wide
// site_title/logo_url/favicon_url settings as before. Exported so
// worker.js can reuse the exact same lookup when server-side rendering
// the <title>/favicon into index.html via HTMLRewriter (see worker.js).
export async function getBrandForHostname(env, hostname) {
  if (!hostname) return null;
  const settings = await getSettings(env.DB);
  if (settings.multisite_branding_enabled !== "1") return null;
  const domain = String(hostname).toLowerCase();
  const row = await env.DB.prepare("SELECT site_title, logo_url, favicon_url FROM multisite_brands WHERE domain = ?").bind(domain).first();
  return row || null;
}

export async function handlePublicSettings(request, env) {
  const settings = await getSettings(env.DB);
  const hostname = new URL(request.url).hostname;
  const brand = await getBrandForHostname(env, hostname);
  return ok({
    // A brand row's field can itself be blank (admin left it empty to
    // intentionally fall back to the site default for just that one
    // field) - so each override only applies when it's a non-empty string,
    // not merely when the brand row exists.
    siteTitle: (brand && brand.site_title) || settings.site_title,
    logoUrl: (brand && brand.logo_url) || settings.logo_url,
    faviconUrl: (brand && brand.favicon_url) || settings.favicon_url,
    socialPreviewUrl: settings.social_preview_url,
    themeColor: settings.theme_color,
    welcomeHeading: settings.welcome_heading,
    welcomeSubheading: settings.welcome_subheading,
    welcomeSmallText: settings.welcome_small_text,
    callLimitCount: settings.call_limit_count,
    callLimitMinutes: settings.call_limit_minutes,
    selfDeletionEnabled: settings.self_deletion_enabled === "1",
    callStatusTimerSeconds: parseInt(settings.call_status_timer_seconds || "20", 10),
    showSeekOption: settings.show_seek_option !== "0",
    showJoinOption: settings.show_join_option !== "0",
    // Opt-in (default hidden) per spec - only "1" turns it on, unlike the
    // other show*Option flags above which default to visible.
    showLogoutButton: settings.show_logout_button === "1",
    otpRequiredForNumberChange: settings.otp_required_for_number_change !== "0",
    profileShareBaseUrl: settings.profile_share_base_url || "",
    defaultAvatars: safeParseJson(settings.default_avatars_json, []),
    whatsappSeekMessage: settings.whatsapp_seek_message || "আসসালামুআলাইকুম। আশা করি ভালো আছেন। {bloodGroup} রক্তদাতা খুঁজছিলাম। আপনি কি এভেইলেবল আছেন?",
  });
}

function safeParseJson(str, fallback) {
  try { return JSON.parse(str || "null") ?? fallback; } catch { return fallback; }
}

// ------------------------------------------------------ MULTISITE BRANDING
// (মাল্টিসাইট ব্র্যান্ডিং) - per-domain override list. Gated behind the same
// manage_site_settings permission as the rest of site branding, since this
// is conceptually an extension of it (multiple sets of title/logo/favicon
// instead of one).
export async function handleMultisiteGet(request, env) {
  const { resp } = await requirePerm(request, env, "manage_site_settings");
  if (resp) return resp;
  const settings = await getSettings(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM multisite_brands ORDER BY sort_order ASC, id ASC").all();
  return ok({ enabled: settings.multisite_branding_enabled === "1", brands: results });
}

export async function handleMultisiteToggle(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_site_settings");
  if (resp) return resp;
  const body = await readJson(request);
  await setSettings(env.DB, { multisite_branding_enabled: body.enabled ? "1" : "0" });
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `মাল্টিসাইট ব্র্যান্ডিং ${body.enabled ? "চালু" : "বন্ধ"} করেছেন` });
  return ok({ updated: true });
}

function normalizeDomain(raw) {
  return String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export async function handleMultisiteCreate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_site_settings");
  if (resp) return resp;
  const body = await readJson(request);
  const domain = normalizeDomain(body.domain);
  if (!domain) return err("ডোমেইন দিন");
  const existing = await env.DB.prepare("SELECT id FROM multisite_brands WHERE domain = ?").bind(domain).first();
  if (existing) return err("এই ডোমেইনটি ইতিমধ্যে তালিকায় আছে");
  await env.DB.prepare("INSERT INTO multisite_brands (domain, site_title, logo_url, favicon_url, sort_order) VALUES (?, ?, ?, ?, ?)")
    .bind(domain, body.siteTitle || "", body.logoUrl || "", body.faviconUrl || "", parseInt(body.sortOrder, 10) || 0)
    .run();
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `মাল্টিসাইট ব্র্যান্ডিং এন্ট্রি যোগ করেছেন (${domain})` });
  return ok({ created: true });
}

export async function handleMultisiteUpdate(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_site_settings");
  if (resp) return resp;
  const body = await readJson(request);
  const domain = normalizeDomain(body.domain);
  if (!domain) return err("ডোমেইন দিন");
  const existing = await env.DB.prepare("SELECT id FROM multisite_brands WHERE domain = ? AND id != ?").bind(domain, id).first();
  if (existing) return err("এই ডোমেইনটি ইতিমধ্যে অন্য একটি এন্ট্রিতে আছে");
  await env.DB.prepare("UPDATE multisite_brands SET domain = ?, site_title = ?, logo_url = ?, favicon_url = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(domain, body.siteTitle || "", body.logoUrl || "", body.faviconUrl || "", parseInt(body.sortOrder, 10) || 0, id)
    .run();
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `মাল্টিসাইট ব্র্যান্ডিং এন্ট্রি আপডেট করেছেন (${domain})` });
  return ok({ updated: true });
}

export async function handleMultisiteDelete(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_site_settings");
  if (resp) return resp;
  const row = await env.DB.prepare("SELECT domain FROM multisite_brands WHERE id = ?").bind(id).first();
  await env.DB.prepare("DELETE FROM multisite_brands WHERE id = ?").bind(id).run();
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: `মাল্টিসাইট ব্র্যান্ডিং এন্ট্রি ডিলিট করেছেন (${row ? row.domain : id})` });
  return ok({ deleted: true });
}

// ------------------------------------------------------------ PERMISSIONS
export async function handlePermissionsList(request, env) {
  const { resp } = await requirePerm(request, env, null);
  if (resp) return resp;
  return ok({ permissions: PERMISSIONS });
}

// -------------------------------------------------------------- ACTIVITY LOG
export async function handleActivityLog(request, env) {
  const { resp } = await requirePerm(request, env, "view_activity_log");
  if (resp) return resp;
  const url = new URL(request.url);
  const who = (url.searchParams.get("who") || "").trim();
  const category = (url.searchParams.get("category") || "").trim();
  const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const dateTo = (url.searchParams.get("dateTo") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const perPage = 50;

  let query = "SELECT * FROM activity_log WHERE 1=1";
  const binds = [];
  if (who) { query += " AND actor_label LIKE ?"; binds.push(`%${who}%`); }
  if (category) { query += " AND category = ?"; binds.push(category); }
  // created_at is stored "YYYY-MM-DD HH:MM:SS" UTC - plain string comparison
  // against a "YYYY-MM-DD" bound works correctly since that format sorts
  // lexicographically the same as chronologically. dateTo is treated as
  // inclusive of the whole day by comparing against the START of the NEXT
  // day, so a person filtering "up to Aug 19" gets all of Aug 19 included.
  if (dateFrom) { query += " AND created_at >= ?"; binds.push(dateFrom); }
  if (dateTo) { query += " AND created_at < date(?, '+1 day')"; binds.push(dateTo); }
  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  binds.push(perPage, (page - 1) * perPage);

  const { results } = await env.DB.prepare(query).bind(...binds).all();

  let countQuery = "SELECT COUNT(*) as c FROM activity_log WHERE 1=1";
  const countBinds = [];
  if (who) { countQuery += " AND actor_label LIKE ?"; countBinds.push(`%${who}%`); }
  if (category) { countQuery += " AND category = ?"; countBinds.push(category); }
  if (dateFrom) { countQuery += " AND created_at >= ?"; countBinds.push(dateFrom); }
  if (dateTo) { countQuery += " AND created_at < date(?, '+1 day')"; countBinds.push(dateTo); }
  const countRow = await env.DB.prepare(countQuery).bind(...countBinds).first();

  return ok({ entries: results, page, perPage, total: countRow.c, totalPages: Math.max(1, Math.ceil(countRow.c / perPage)) });
}

// Manual purge: deletes ALL activity log rows outright, or only rows older
// than N days when olderThanDays is given (used by both the "ডিলিট করুন
// সব" button and as the underlying logic the scheduled auto-purge below
// reuses with a fixed cutoff).
export async function handleActivityLogPurge(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "view_activity_log");
  if (resp) return resp;
  const body = await readJson(request);
  const olderThanDays = body.olderThanDays ? parseInt(body.olderThanDays, 10) : null;
  let result;
  if (olderThanDays && olderThanDays > 0) {
    result = await env.DB.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', ?)").bind(`-${olderThanDays} days`).run();
  } else {
    result = await env.DB.prepare("DELETE FROM activity_log").run();
  }
  // Deliberately logged AFTER the purge (this entry always survives) so
  // there's always at least a record that a purge happened and by whom.
  await logActivity(env.DB, {
    actorUser: admin,
    category: "admin",
    actionText: olderThanDays ? `এক্টিভিটি লগ পার্জ করেছেন (${olderThanDays} দিনের পুরনো)` : "এক্টিভিটি লগ সম্পূর্ণ পার্জ করেছেন",
  });
  return ok({ purged: true, deletedCount: result.meta.changes });
}

export async function handleActivityLogPurgeScheduleGet(request, env) {
  const { resp } = await requirePerm(request, env, "view_activity_log");
  if (resp) return resp;
  const settings = await getSettings(env.DB);
  return ok({
    enabled: settings.activity_log_auto_purge_enabled === "1",
    olderThanDays: parseInt(settings.activity_log_auto_purge_days, 10) || 30,
  });
}

export async function handleActivityLogPurgeScheduleUpdate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "view_activity_log");
  if (resp) return resp;
  const body = await readJson(request);
  const patch = {};
  if (body.enabled !== undefined) patch.activity_log_auto_purge_enabled = body.enabled ? "1" : "0";
  if (body.olderThanDays !== undefined) {
    const days = parseInt(body.olderThanDays, 10);
    if (!Number.isFinite(days) || days < 1) return err("সঠিক সংখ্যক দিন দিন (কমপক্ষে ১)");
    patch.activity_log_auto_purge_days = String(days);
  }
  await setSettings(env.DB, patch);
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: "এক্টিভিটি লগ অটো-পার্জ সেটিংস আপডেট করেছেন" });
  return ok({ updated: true });
}

// -------------------------------------------------------- SMS ANALYTICS
export async function handleSmsAnalyticsGet(request, env) {
  const { resp } = await requirePerm(request, env, "view_activity_log");
  if (resp) return resp;
  const { results: current } = await env.DB
    .prepare("SELECT mobile, name, sms_highest_daily_count, sms_highest_daily_date FROM users WHERE deleted = 0 AND sms_highest_daily_count > 0 ORDER BY sms_highest_daily_count DESC LIMIT 20")
    .all();
  const { results: history } = await env.DB
    .prepare("SELECT mobile, count, record_date, reset_at FROM sms_daily_record_history ORDER BY reset_at DESC LIMIT 50")
    .all();
  return ok({ current, history });
}

// Manual reset - same archive-then-clear behaviour as the automatic
// monthly sweep (runSmsDailyReset in scheduled.js), triggerable on demand.
export async function handleSmsAnalyticsReset(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "view_activity_log");
  if (resp) return resp;
  const { results } = await env.DB.prepare("SELECT id, mobile, sms_highest_daily_count, sms_highest_daily_date FROM users WHERE sms_highest_daily_count > 0").all();
  for (const u of results) {
    await env.DB
      .prepare("INSERT INTO sms_daily_record_history (mobile, count, record_date) VALUES (?, ?, ?)")
      .bind(u.mobile, u.sms_highest_daily_count, u.sms_highest_daily_date)
      .run();
  }
  await env.DB.prepare("UPDATE users SET sms_highest_daily_count = 0, sms_highest_daily_date = NULL").run();
  await setSettings(env.DB, { sms_highest_daily_reset_month: new Date().toISOString().slice(0, 7) });
  await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: "সর্বোচ্চ দৈনিক SMS রেকর্ড ম্যানুয়ালি রিসেট করেছেন" });
  return ok({ reset: true });
}

// Manually bump either daily SMS limit for one or more selected users,
// without touching the site-wide default - null clears back to "use site
// default".
export async function handleSmsLimitOverride(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_users");
  if (resp) return resp;
  const body = await readJson(request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((n) => Number.isInteger(n)) : [];
  if (!ids.length) return err("কোনো ইউজার নির্বাচন করা হয়নি");
  const placeholders = ids.map(() => "?").join(",");
  const patches = [];
  if (body.userInitiatedLimit !== undefined) {
    const v = body.userInitiatedLimit === null ? null : Math.max(0, parseInt(body.userInitiatedLimit, 10) || 0);
    patches.push(["sms_user_initiated_limit_override", v]);
  }
  if (body.systemLimit !== undefined) {
    const v = body.systemLimit === null ? null : Math.max(0, parseInt(body.systemLimit, 10) || 0);
    patches.push(["sms_system_limit_override", v]);
  }
  if (!patches.length) return err("কোনো পরিবর্তন পাওয়া যায়নি");
  for (const [col, val] of patches) {
    await env.DB.prepare(`UPDATE users SET ${col} = ? WHERE id IN (${placeholders})`).bind(val, ...ids).run();
  }
  await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `${ids.length} জন ইউজারের SMS লিমিট ওভাররাইড আপডেট করেছেন` });
  return ok({ updated: true });
}

// Admin sweep: claims a donor.bd username for every account that doesn't
// have one registered there yet - either the exact slug they already have
// locally (if still available on donor.bd) or a freshly generated random
// one otherwise. See claimUnregisteredDonorbdSlugs in lib/donorbd.js for
// the actual per-user logic.
export async function handleClaimUnregisteredDonorbdSlugs(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_users");
  if (resp) return resp;
  const settings = await getSettings(env.DB);
  const baseUrl = new URL(request.url).origin;
  const result = await claimUnregisteredDonorbdSlugs(env.DB, settings, baseUrl);
  if (!result.configured) return err("donor.bd কনফিগার করা নেই (Site API সেটিংসে API Key/Base URL দিন)");
  await logActivity(env.DB, {
    actorUser: admin,
    category: "admin",
    actionText: `donor.bd আনরেজিস্টার্ড ইউজারনেইম ক্লেইম করেছেন: ${result.fixed}টি সফল, ${result.failed}টি ব্যর্থ`,
  });
  return ok(result);
}

// ------------------------------------------------------------ TELEGRAM BOTS
// See the Telegram bot implementation plan §6 for the full spec. Tokens/
// webhook secrets live in D1 (not wrangler secret) since the set of bots is
// admin-managed and dynamic - see telegram_bots in
// arc/migration_telegram_bot.sql. The raw token is NEVER sent back to the
// admin UI once saved (see botPublicShape's maskToken below) - an edit
// leaves the token field blank, meaning "keep the existing token".

function genWebhookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 12) return `${token.slice(0, 2)}…${token.slice(-2)}`;
  return `${token.slice(0, 10)}…${token.slice(-4)}`;
}

function botPublicShape(row) {
  return {
    id: row.id,
    name: row.name,
    botUsername: row.bot_username,
    tokenMasked: maskToken(row.bot_token),
    enabledDm: !!row.enabled_dm,
    enabledGroups: !!row.enabled_groups,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function handleTelegramBotsList(request, env) {
  const { resp } = await requirePerm(request, env, "manage_telegram_bots");
  if (resp) return resp;
  const { results } = await env.DB.prepare("SELECT * FROM telegram_bots ORDER BY created_at DESC").all();
  return ok({ bots: results.map(botPublicShape) });
}

// Handles both create (no id) and edit (id given), including a lightweight
// active/inactive-only toggle (name/botToken omitted, isActive given) that
// skips the getMe/setWebhook round-trip entirely since nothing about the
// bot's Telegram-side registration needs to change for that.
export async function handleTelegramBotSave(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_telegram_bots");
  if (resp) return resp;
  const body = await readJson(request);

  if (id && body.name === undefined && body.botToken === undefined && body.isActive !== undefined) {
    const existing = await env.DB.prepare("SELECT name FROM telegram_bots WHERE id = ?").bind(id).first();
    if (!existing) return err("বট পাওয়া যায়নি", 404);
    await env.DB.prepare("UPDATE telegram_bots SET is_active = ?, updated_at = ? WHERE id = ?").bind(body.isActive ? 1 : 0, nowIso(), id).run();
    await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `টেলিগ্রাম বট ${body.isActive ? "চালু" : "বন্ধ"} করেছেন: ${existing.name}` });
    return ok({ updated: true });
  }

  const name = (body.name || "").trim();
  if (!name) return err("বটের নাম দিন");
  const tokenInput = (body.botToken || "").trim();
  const isCreate = !id;
  if (isCreate && !tokenInput) return err("টেলিগ্রাম বট টোকেন দিন");

  const enabledDm = body.enabledDm !== undefined ? (body.enabledDm ? 1 : 0) : 1;
  const enabledGroups = body.enabledGroups !== undefined ? (body.enabledGroups ? 1 : 0) : 1;

  // Never derived from the request's own origin (a webhook call has no
  // "browser origin" the way a page load does) - always the configured
  // public domain, falling back to this admin request's origin only if
  // that var was never set, so bot setup doesn't hard-fail on a fresh
  // install before PUBLIC_SEEK_BASE_URL is configured.
  const publicBaseUrl = (env.PUBLIC_SEEK_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");

  if (isCreate) {
    let botUsername;
    try {
      botUsername = (await getMe(tokenInput)).username;
    } catch (e) {
      return err(e.message);
    }
    const secret = genWebhookSecret();
    const res = await env.DB
      .prepare("INSERT INTO telegram_bots (name, bot_token, bot_username, webhook_secret, enabled_dm, enabled_groups, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .bind(name, tokenInput, botUsername, secret, enabledDm, enabledGroups, nowIso(), nowIso())
      .run();
    const newId = res.meta.last_row_id;
    try {
      await setWebhook(tokenInput, `${publicBaseUrl}/api/telegram/webhook/${newId}`, secret);
    } catch (e) {
      // Both getMe and setWebhook must succeed before the row is treated as
      // persisted (plan §6.4) - roll the tentative insert back.
      await env.DB.prepare("DELETE FROM telegram_bots WHERE id = ?").bind(newId).run();
      return err(`ওয়েবহুক রেজিস্টার ব্যর্থ: ${e.message}`);
    }
    await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `টেলিগ্রাম বট যোগ করেছেন: ${name} (@${botUsername})` });
    return ok({ id: newId });
  }

  const existing = await env.DB.prepare("SELECT * FROM telegram_bots WHERE id = ?").bind(id).first();
  if (!existing) return err("বট পাওয়া যায়নি", 404);

  let tokenToUse = existing.bot_token;
  let botUsername = existing.bot_username;
  let secret = existing.webhook_secret;
  let tokenChanged = false;

  if (tokenInput) {
    try {
      botUsername = (await getMe(tokenInput)).username;
    } catch (e) {
      return err(e.message);
    }
    tokenToUse = tokenInput;
    secret = genWebhookSecret(); // regenerated on every token change - simplest and safest (plan §6.4)
    tokenChanged = true;
  }

  try {
    await setWebhook(tokenToUse, `${publicBaseUrl}/api/telegram/webhook/${id}`, secret);
  } catch (e) {
    return err(`ওয়েবহুক রেজিস্টার ব্যর্থ: ${e.message}`);
  }

  await env.DB
    .prepare("UPDATE telegram_bots SET name = ?, bot_token = ?, bot_username = ?, webhook_secret = ?, enabled_dm = ?, enabled_groups = ?, updated_at = ? WHERE id = ?")
    .bind(name, tokenToUse, botUsername, secret, enabledDm, enabledGroups, nowIso(), id)
    .run();
  await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `টেলিগ্রাম বট আপডেট করেছেন: ${name}${tokenChanged ? " (টোকেন পরিবর্তিত)" : ""}` });
  return ok({ updated: true });
}

export async function handleTelegramBotDelete(request, env, id) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_telegram_bots");
  if (resp) return resp;
  const row = await env.DB.prepare("SELECT name, bot_token FROM telegram_bots WHERE id = ?").bind(id).first();
  // Best-effort - stops Telegram retrying against a URL this app no longer
  // intends to serve; a failure here shouldn't block the row from being removed.
  if (row) await deleteWebhook(row.bot_token);
  await env.DB.prepare("DELETE FROM telegram_bots WHERE id = ?").bind(id).run();
  await logActivity(env.DB, { actorUser: admin, category: "admin", actionText: `টেলিগ্রাম বট ডিলিট করেছেন: ${row ? row.name : id}` });
  return ok({ deleted: true });
}

// -------------------------------------------------------------- TELEGRAM LOG
export async function handleTelegramMessagesList(request, env) {
  const { resp } = await requirePerm(request, env, "manage_telegram_bots");
  if (resp) return resp;
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const perPage = 50;
  const botIdFilter = url.searchParams.get("botId");

  let query = "SELECT tm.*, tb.name as bot_name FROM telegram_messages tm LEFT JOIN telegram_bots tb ON tb.id = tm.bot_id WHERE 1=1";
  const binds = [];
  if (botIdFilter) { query += " AND tm.bot_id = ?"; binds.push(botIdFilter); }
  query += " ORDER BY tm.created_at DESC LIMIT ? OFFSET ?";
  binds.push(perPage, (page - 1) * perPage);
  const { results } = await env.DB.prepare(query).bind(...binds).all();

  let countQuery = "SELECT COUNT(*) as c FROM telegram_messages WHERE 1=1";
  const countBinds = [];
  if (botIdFilter) { countQuery += " AND bot_id = ?"; countBinds.push(botIdFilter); }
  const countRow = await env.DB.prepare(countQuery).bind(...countBinds).first();

  return ok({ entries: results, page, perPage, total: countRow.c, totalPages: Math.max(1, Math.ceil(countRow.c / perPage)) });
}

// Deletes the BOT'S OWN outbound reply only (plan §5.4) - the inbound
// message is never touched, which sidesteps the admin-rights/Guest-Bot
// limitation entirely (a bot can always delete its own messages in any
// chat/group/supergroup it's a member of, no special rights needed).
export async function handleTelegramMessageDelete(request, env, id) {
  const { resp } = await requirePerm(request, env, "manage_telegram_bots");
  if (resp) return resp;
  const row = await env.DB
    .prepare("SELECT tm.*, tb.bot_token FROM telegram_messages tm LEFT JOIN telegram_bots tb ON tb.id = tm.bot_id WHERE tm.id = ?")
    .bind(id)
    .first();
  if (!row) return err("পাওয়া যায়নি", 404);
  if (!row.outbound_message_id) return err("এই এন্ট্রির কোনো আউটবাউন্ড মেসেজ নেই");
  if (!row.bot_token) return err("এই বটটি আর কনফিগার করা নেই, ডিলিট করা যাচ্ছে না");

  // created_at is stored as "YYYY-MM-DD HH:MM:SS" UTC (nowIso's format) -
  // reconstruct an ISO string to compare against Telegram's 48h delete
  // window (plan §5.4 step 1).
  const createdMs = Date.parse(`${row.created_at.replace(" ", "T")}Z`);
  const ageHours = (Date.now() - createdMs) / 3600000;
  if (Number.isFinite(ageHours) && ageHours > 48) return err("৪৮ ঘন্টার বেশি পুরনো মেসেজ ডিলিট করা যায় না (টেলিগ্রামের লিমিট)");

  const result = await deleteMessage(row.bot_token, row.chat_id, row.outbound_message_id);
  // Marked deleted locally regardless of Telegram's exact outcome (already
  // deleted / chat gone, etc. all land at the same end state) - see plan
  // §5.4 step 4.
  await env.DB.prepare("UPDATE telegram_messages SET deleted_at = ? WHERE id = ?").bind(nowIso(), id).run();
  return ok({ deleted: true, telegramOk: result.ok, telegramDescription: result.description || null });
}
