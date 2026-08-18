import { ok, err, readJson, isValidBdMobile, genOtp, hashPassword, verifyPassword, nowIso } from "../lib/util.js";
import { getSettings, settingInt } from "../lib/settings.js";
import { storeOtp, verifyOtp } from "../lib/kvstore.js";
import { dispatchOtp, sendNotificationSms, fillTemplate } from "../lib/sms.js";
import { createSessionCookie, clearSessionCookie, getCurrentUser, publicUserFields } from "../lib/authctx.js";
import { logActivity } from "../lib/activity.js";

const OTP_PURPOSES = ["register", "reset", "change_mobile"];

export async function handleCheckMobile(request, env) {
  const url = new URL(request.url);
  const mobile = (url.searchParams.get("mobile") || "").trim();
  if (!isValidBdMobile(mobile)) return err("সঠিক মোবাইল নাম্বার দিন");
  const existing = await env.DB.prepare("SELECT id FROM users WHERE mobile = ? AND deleted = 0").bind(mobile).first();
  return ok({ exists: !!existing });
}

export async function handleOtpSend(request, env) {
  const body = await readJson(request);
  const mobile = (body.mobile || "").trim();
  const purpose = body.purpose;
  if (!isValidBdMobile(mobile)) return err("সঠিক মোবাইল নাম্বার দিন");
  if (!OTP_PURPOSES.includes(purpose)) return err("Invalid OTP purpose");

  const settings = await getSettings(env.DB);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE mobile = ? AND deleted = 0").bind(mobile).first();
  if (purpose === "register" && existing) return err("এই মোবাইল নাম্বারে ইতিমধ্যে একাউন্ট আছে");
  if (purpose === "change_mobile" && existing) return err("এই মোবাইল নাম্বার ইতিমধ্যে ব্যবহৃত হচ্ছে");
  if (purpose === "reset" && !existing) {
    // Do not reveal whether the account exists.
    return ok({ sent: true });
  }

  const code = genOtp();
  const manual = (settings.manual_otp || "").trim();
  if (!manual) {
    await storeOtp(env.KV, purpose, mobile, code);
  }
  await dispatchOtp(env.DB, settings, mobile, code);
  return ok({ sent: true });
}

async function checkOtp(env, settings, purpose, mobile, code) {
  const manual = (settings.manual_otp || "").trim();
  return verifyOtp(env.KV, purpose, mobile, code, manual || null);
}

export async function handleRegister(request, env) {
  const body = await readJson(request);
  const mobile = (body.mobile || "").trim();
  const password = body.password || "";
  const otp = body.otp || "";
  if (!isValidBdMobile(mobile)) return err("সঠিক মোবাইল নাম্বার দিন");
  if (password.length < 4) return err("পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে");

  const settings = await getSettings(env.DB);
  const result = await checkOtp(env, settings, "register", mobile, otp);
  if (result !== "ok") return err(otpErrorMessage(result));

  const existing = await env.DB.prepare("SELECT id FROM users WHERE mobile = ? AND deleted = 0").bind(mobile).first();
  if (existing) return err("এই মোবাইল নাম্বারে ইতিমধ্যে একাউন্ট আছে");

  const passwordHash = await hashPassword(password);
  const res = await env.DB
    .prepare("INSERT INTO users (mobile, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(mobile, passwordHash, nowIso(), nowIso())
    .run();
  const userId = res.meta.last_row_id;

  const msg = fillTemplate(settings.sms_account_created_self, { siteTitle: settings.site_title });
  await sendNotificationSms(env.DB, settings, mobile, msg, "account_created_self");
  await logActivity(env.DB, { actorLabel: mobile, category: "account", actionText: `নতুন একাউন্ট তৈরি হয়েছে (${mobile})` });

  const cookie = await createSessionCookie(userId, request, env, settingInt(settings, "session_days", 90));
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  return ok({ user: publicUserFields(user) }, { headers: { "Set-Cookie": cookie } });
}

export async function handleLogin(request, env) {
  const body = await readJson(request);
  const mobile = (body.mobile || "").trim();
  const password = body.password || "";
  if (!isValidBdMobile(mobile)) return err("সঠিক মোবাইল নাম্বার দিন");

  await maybeBootstrapRootAdmin(env, mobile);

  const user = await env.DB.prepare("SELECT * FROM users WHERE mobile = ? AND deleted = 0").bind(mobile).first();
  if (!user) return err("মোবাইল নাম্বার অথবা পাসওয়ার্ড সঠিক নয়");
  if (user.disabled) return err("এই একাউন্টটি নিষ্ক্রিয় করা হয়েছে");
  const validPw = await verifyPassword(password, user.password_hash);
  if (!validPw) return err("মোবাইল নাম্বার অথবা পাসওয়ার্ড সঠিক নয়");

  const settings = await getSettings(env.DB);
  const cookie = await createSessionCookie(user.id, request, env, settingInt(settings, "session_days", 90));
  await logActivity(env.DB, { actorUser: user, category: "account", actionText: "লগইন করেছেন" });
  return ok({ user: publicUserFields(user) }, { headers: { "Set-Cookie": cookie } });
}

async function maybeBootstrapRootAdmin(env, mobile) {
  if (!env.ROOT_ADMIN_MOBILE || mobile !== env.ROOT_ADMIN_MOBILE) return;
  const rootExists = await env.DB.prepare("SELECT id FROM users WHERE is_root_admin = 1").first();
  if (rootExists) return;

  const passwordHash = await hashPassword(env.ROOT_ADMIN_PASSWORD || crypto.randomUUID());

  // A regular account may already be using this number (e.g. created via
  // /seek or /join while testing, before ROOT_ADMIN_MOBILE was set as a
  // secret). Inserting a second row with the same mobile would violate the
  // UNIQUE(mobile) constraint, so promote the existing row instead.
  const existingByMobile = await env.DB.prepare("SELECT id FROM users WHERE mobile = ?").bind(mobile).first();
  if (existingByMobile) {
    await env.DB
      .prepare(
        "UPDATE users SET password_hash = ?, is_admin = 1, is_root_admin = 1, must_change_password = 1, disabled = 0, deleted = 0, updated_at = ? WHERE id = ?"
      )
      .bind(passwordHash, nowIso(), existingByMobile.id)
      .run();
    return;
  }

  await env.DB
    .prepare(
      "INSERT INTO users (mobile, password_hash, name, is_admin, is_root_admin, must_change_password, created_at, updated_at) VALUES (?, ?, 'Root Admin', 1, 1, 1, ?, ?)"
    )
    .bind(mobile, passwordHash, nowIso(), nowIso())
    .run();
}

export async function handleForgotPasswordReset(request, env) {
  const body = await readJson(request);
  const mobile = (body.mobile || "").trim();
  const otp = body.otp || "";
  const newPassword = body.newPassword || "";
  if (!isValidBdMobile(mobile)) return err("সঠিক মোবাইল নাম্বার দিন");
  if (newPassword.length < 4) return err("পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে");

  const settings = await getSettings(env.DB);
  const result = await checkOtp(env, settings, "reset", mobile, otp);
  if (result !== "ok") return err(otpErrorMessage(result));

  const user = await env.DB.prepare("SELECT * FROM users WHERE mobile = ? AND deleted = 0").bind(mobile).first();
  if (!user) return ok({ reset: true }); // never reveal existence

  const passwordHash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?")
    .bind(passwordHash, nowIso(), user.id)
    .run();
  await logActivity(env.DB, { actorUser: user, category: "account", actionText: "পাসওয়ার্ড রিসেট করেছেন (ভুলে যাওয়া পাসওয়ার্ড)" });
  return ok({ reset: true });
}

export async function handleChangePassword(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const body = await readJson(request);
  const oldPassword = body.oldPassword || "";
  const newPassword = body.newPassword || "";
  if (newPassword.length < 4) return err("পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে");
  const validOld = await verifyPassword(oldPassword, user.password_hash);
  if (!validOld) return err("বর্তমান পাসওয়ার্ড সঠিক নয়");
  const passwordHash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?")
    .bind(passwordHash, nowIso(), user.id)
    .run();
  await logActivity(env.DB, { actorUser: user, category: "account", actionText: "পাসওয়ার্ড পরিবর্তন করেছেন" });
  return ok({ changed: true });
}

export async function handleLogout(request, env) {
  return ok({ loggedOut: true }, { headers: { "Set-Cookie": clearSessionCookie(request) } });
}

export async function handleMe(request, env) {
  const user = await getCurrentUser(request, env);
  return ok({ user: publicUserFields(user) });
}

function otpErrorMessage(result) {
  if (result === "expired") return "OTP মেয়াদ উত্তীর্ণ হয়েছে, আবার চেষ্টা করুন";
  if (result === "too_many_attempts") return "অনেকবার ভুল চেষ্টা হয়েছে, নতুন OTP নিন";
  return "OTP সঠিক নয়";
}

export { checkOtp, otpErrorMessage };
