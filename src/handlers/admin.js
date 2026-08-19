import { ok, err, readJson, isValidBdMobile, isValidBloodGroup, hashPassword, nowIso } from "../lib/util.js";
import { getSettings, setSettings } from "../lib/settings.js";
import { getCurrentUser } from "../lib/authctx.js";
import { hasPermission, isAnyAdmin, PERMISSIONS } from "../lib/permissions.js";
import { logActivity } from "../lib/activity.js";

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
  const totalEligible = (await db.prepare("SELECT COUNT(*) c FROM users WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'on'").first()).c;
  const totalCallsMade = (await db.prepare("SELECT COUNT(*) c FROM calls").first()).c;
  const totalManaged = (await db.prepare("SELECT COUNT(*) c FROM calls WHERE status = 'can_donate'").first()).c;
  const totalCallsReceived = totalCallsMade;
  const totalSnoozed = (await db.prepare("SELECT COUNT(*) c FROM users WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'snoozed'").first()).c;

  const byGroup = await db
    .prepare(
      `SELECT blood_group, COUNT(*) as total, SUM(CASE WHEN eligibility_status='on' THEN 1 ELSE 0 END) as eligible
       FROM users WHERE deleted = 0 AND is_donor = 1 AND blood_group IS NOT NULL GROUP BY blood_group`
    )
    .all();

  return ok({
    totalUsers,
    totalDonors,
    totalEligible,
    totalCallsMade,
    totalManaged,
    totalCallsReceived,
    totalSnoozed,
    byGroup: byGroup.results,
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
  const res = await env.DB
    .prepare(
      "INSERT INTO users (mobile, password_hash, name, is_donor, blood_group, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(mobile, passwordHash, body.name || null, body.isDonor ? 1 : 0, isValidBloodGroup(body.bloodGroup) ? body.bloodGroup : null, mustChange, nowIso(), nowIso())
    .run();

  const settings = await getSettings(env.DB);
  const { sendNotificationSms, fillTemplate } = await import("../lib/sms.js");
  const msg = fillTemplate(settings.sms_account_created_import, { password });
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
  await env.DB.prepare("UPDATE users SET deleted = 1, updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
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
    await env.DB.prepare(`UPDATE users SET deleted = 1, updated_at = ? WHERE id IN (${placeholders}) AND is_root_admin = 0`).bind(nowIso(), ...ids).run();
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
    const msg = fillTemplate(settings.sms_password_reset_by_admin, { password: newPassword });
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

  for (const row of rows) {
    const mobile = (row.mobile || "").trim();
    if (!isValidBdMobile(mobile)) { errors.push(`${mobile || "(খালি)"}: অবৈধ মোবাইল`); continue; }
    const existing = await env.DB.prepare("SELECT id FROM users WHERE mobile = ? AND deleted = 0").bind(mobile).first();
    if (existing) { errors.push(`${mobile}: ইতিমধ্যে আছে`); continue; }
    const password = row.password || Math.random().toString(36).slice(2, 10);
    const passwordHash = await hashPassword(password);
    await env.DB
      .prepare(
        "INSERT INTO users (mobile, password_hash, name, blood_group, is_donor, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(mobile, passwordHash, row.name || null, isValidBloodGroup(row.bloodGroup) ? row.bloodGroup : null, row.isDonor === "1" || row.isDonor === "true" ? 1 : 0, requireChangeOnLogin ? 1 : 0, nowIso(), nowIso())
      .run();
    const msg = fillTemplate(settings.sms_account_created_import, { password });
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
    otp_test_mode: settings.otp_test_mode === "1",
    manual_otp: settings.manual_otp,
    greensms_api_key: settings.greensms_api_key,
    sms_enabled_account_created_self: settings.sms_enabled_account_created_self !== "0",
    sms_enabled_account_created_import: settings.sms_enabled_account_created_import !== "0",
    sms_enabled_otp: settings.sms_enabled_otp !== "0",
    sms_enabled_password_reset: settings.sms_enabled_password_reset !== "0",
  });
}

export async function handleSmsSettingsUpdate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_sms_settings");
  if (resp) return resp;
  const body = await readJson(request);
  const allowed = ["sms_account_created_self", "sms_account_created_import", "sms_otp", "sms_password_reset_by_admin", "manual_otp", "greensms_api_key"];
  const patch = {};
  for (const k of allowed) if (typeof body[k] === "string") patch[k] = body[k];
  if (body.otp_test_mode !== undefined) patch.otp_test_mode = body.otp_test_mode ? "1" : "0";
  for (const k of ["sms_enabled_account_created_self", "sms_enabled_account_created_import", "sms_enabled_otp", "sms_enabled_password_reset"]) {
    if (body[k] !== undefined) patch[k] = body[k] ? "1" : "0";
  }
  await setSettings(env.DB, patch);
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: "এসএমএস সেটিংস আপডেট করেছেন" });
  return ok({ updated: true });
}

const SMS_TEMPLATE_KEYS = ["sms_account_created_self", "sms_account_created_import", "sms_otp", "sms_password_reset_by_admin"];

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
  };
  const message = fillTemplate(settings[body.templateKey], sample);
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
    self_deletion_enabled: settings.self_deletion_enabled === "1",
    session_days: settings.session_days || "90",
    show_seek_option: settings.show_seek_option !== "0",
    show_join_option: settings.show_join_option !== "0",
    show_logout_button: settings.show_logout_button === "1",
    profile_share_base_url: settings.profile_share_base_url || "",
    default_avatars_json: settings.default_avatars_json || "[]",
    // moved here from Site APIs - these govern the /seek system, not third-party credentials
    otp_required_for_number_change: settings.otp_required_for_number_change !== "0",
    call_limit_count: settings.call_limit_count,
    call_limit_minutes: settings.call_limit_minutes,
    donor_lock_minutes: settings.donor_lock_minutes,
    call_status_timer_seconds: settings.call_status_timer_seconds || "20",
  });
}

export async function handleSiteSettingsUpdate(request, env) {
  const { user: admin, resp } = await requirePerm(request, env, "manage_site_settings");
  if (resp) return resp;
  const body = await readJson(request);
  const patch = {};
  for (const k of ["site_title", "logo_url", "favicon_url", "social_preview_url", "theme_color", "welcome_heading", "welcome_subheading", "welcome_small_text", "profile_share_base_url", "default_avatars_json"]) {
    if (typeof body[k] === "string") patch[k] = body[k];
  }
  if (body.eligibility_wait_months !== undefined) patch.eligibility_wait_months = String(parseInt(body.eligibility_wait_months, 10) || 0);
  if (body.self_deletion_enabled !== undefined) patch.self_deletion_enabled = body.self_deletion_enabled ? "1" : "0";
  if (body.session_days !== undefined) patch.session_days = String(Math.max(1, parseInt(body.session_days, 10) || 90));
  if (body.show_seek_option !== undefined) patch.show_seek_option = body.show_seek_option ? "1" : "0";
  if (body.show_join_option !== undefined) patch.show_join_option = body.show_join_option ? "1" : "0";
  if (body.show_logout_button !== undefined) patch.show_logout_button = body.show_logout_button ? "1" : "0";
  if (body.otp_required_for_number_change !== undefined) patch.otp_required_for_number_change = body.otp_required_for_number_change ? "1" : "0";
  for (const k of ["call_limit_count", "call_limit_minutes", "donor_lock_minutes", "call_status_timer_seconds"]) {
    if (body[k] !== undefined) patch[k] = String(Math.max(1, parseInt(body[k], 10) || 1));
  }
  await setSettings(env.DB, patch);
  await logActivity(env.DB, { actorUser: admin, category: "settings", actionText: "সাইট সেটিংস আপডেট করেছেন" });
  return ok({ updated: true });
}

// -------------------------------------------------------- PUBLIC SETTINGS
export async function handlePublicSettings(request, env) {
  const settings = await getSettings(env.DB);
  return ok({
    siteTitle: settings.site_title,
    logoUrl: settings.logo_url,
    faviconUrl: settings.favicon_url,
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
  });
}

function safeParseJson(str, fallback) {
  try { return JSON.parse(str || "null") ?? fallback; } catch { return fallback; }
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
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const perPage = 50;

  let query = "SELECT * FROM activity_log WHERE 1=1";
  const binds = [];
  if (who) { query += " AND actor_label LIKE ?"; binds.push(`%${who}%`); }
  if (category) { query += " AND category = ?"; binds.push(category); }
  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  binds.push(perPage, (page - 1) * perPage);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return ok({ entries: results, page });
}
