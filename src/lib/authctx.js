import { signJwt, verifyJwt } from "./jwt.js";
import { getCookie } from "./util.js";

const COOKIE_NAME = "bn2_session";
const DEFAULT_SESSION_DAYS = 90;

export async function createSessionCookie(userId, request, env, sessionDays) {
  const days = Number.isFinite(sessionDays) && sessionDays > 0 ? sessionDays : DEFAULT_SESSION_DAYS;
  const seconds = days * 24 * 60 * 60;
  const token = await signJwt({ uid: userId }, env.JWT_SECRET, seconds);
  const secure = isHttps(request) ? " Secure;" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${seconds}; HttpOnly;${secure} SameSite=Lax`;
}

export function clearSessionCookie(request) {
  const secure = isHttps(request) ? " Secure;" : "";
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly;${secure} SameSite=Lax`;
}

// Browsers silently refuse to store a "Secure" cookie unless the page was
// loaded over HTTPS. Production (workers.dev / custom domains on Cloudflare)
// is always HTTPS, but local `wrangler dev` over plain http:// is not - so
// the flag is only added when the incoming request is actually secure,
// otherwise login would appear to "not stick" during local testing.
function isHttps(request) {
  if (!request) return true; // default to the safer flag when unknown
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return true;
  }
}

export async function getCurrentUser(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;
  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload || !payload.uid) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").bind(payload.uid).first();
  if (!user) return null;
  if (user.disabled) return null;
  return user;
}

export function publicUserFields(u) {
  if (!u) return null;
  return {
    id: u.id,
    mobile: u.mobile,
    name: u.name,
    username: u.username_display,
    isAdmin: !!u.is_admin,
    isRootAdmin: !!u.is_root_admin,
    permissions: JSON.parse(u.permissions_json || "[]"),
    isDonor: !!u.is_donor,
    bloodGroup: u.blood_group,
    mustChangePassword: !!u.must_change_password,
    profilePicUrl: u.profile_pic_url,
  };
}
