// Generic helpers shared across handlers.
import { getSettings } from "./settings.js";

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function err(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, { status });
}

export function ok(data = {}, init = {}) {
  return json({ ok: true, ...data }, init);
}

// --- Password hashing (PBKDF2-SHA256 via Web Crypto, no external deps) ---
const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashBuf = await pbkdf2(password, salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(hashBuf))}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = unb64(parts[2]);
  const expected = unb64(parts[3]);
  const hashBuf = await pbkdf2(password, salt, iterations);
  const actual = new Uint8Array(hashBuf);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function pbkdf2(password, salt, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, 256
  );
}

export function b64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- Validation ---
export function isValidBdMobile(mobile) {
  return /^01[3-9]\d{8}$/.test(mobile || "");
}

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"];

export function isValidBloodGroup(bg) {
  return BLOOD_GROUPS.includes(bg);
}

export function isValidUsernameSlug(slug) {
  return /^[a-zA-Z0-9_-]{3,32}$/.test(slug || "");
}

// 6-character random username assigned to every new account (self-
// registered or admin-created) at creation time - uppercase letters and
// digits, e.g. AHF21B, FNW212, F12FD2. Donors/users can still change it
// later via the normal username-claim flow; this is just a sane default so
// no account is ever left without a shareable profile URL.
export function genRandomSlug(len = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const rnd = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += chars[rnd[i] % chars.length];
  return out;
}

// Loops genRandomSlug until it finds one not already taken (collisions are
// rare at 36^6 combinations but not impossible) and not on the reserved
// list, so a brand new account never accidentally lands on a value that
// collides with an existing profile or a reserved app path.
export async function genUniqueRandomSlug(db, reservedLower) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = genRandomSlug(6);
    if (reservedLower.has(candidate.toLowerCase())) continue;
    const taken = await db.prepare("SELECT id FROM users WHERE LOWER(username_slug) = LOWER(?)").bind(candidate).first();
    if (!taken) return candidate;
  }
  // Astronomically unlikely fallback: fall back to a longer random slug so
  // account creation never actually fails because of this.
  return genRandomSlug(10);
}

// App-level paths that would become unreachable if claimed as a username
// (since /:slug is how a public profile resolves) - always reserved,
// regardless of admin settings. The admin-managed reserved_usernames
// setting (comma-separated, checked by callers) adds to this list, never
// replaces it.
export const BUILTIN_RESERVED_SLUGS = [
  "seek", "join", "login", "logout", "register", "forgot-password", "quick",
  "profile", "profile-edit", "calls", "settings", "admin", "api", "u",
  "assets", "img", "css", "js", "static", "help", "about", "contact",
  "privacy", "terms", "index", "home",
];

export async function getReservedSlugSet(db) {
  const settings = await getSettings(db);
  const extra = (settings.reserved_usernames || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILTIN_RESERVED_SLUGS, ...extra]);
}

export function genOtp() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, "0");
}

// visibleDigits controls how many digits show at the START before the mask
// (admin-configurable via settings.mask_visible_digits, default 4 - e.g.
// "0138" then stars then the last 2, matching the site default example
// "013******34"). Total length and the trailing 2 digits are fixed to
// match Bangladeshi mobile number conventions; only the leading reveal
// width changes.
export function maskMobile(mobile, settings) {
  if (!mobile || mobile.length < 11) return mobile;
  const visible = settings ? (parseInt(settings.mask_visible_digits, 10) || 4) : 4;
  const clamped = Math.max(2, Math.min(8, visible));
  const trailing = mobile.slice(9);
  const leading = mobile.slice(0, clamped);
  const starCount = 11 - clamped - trailing.length;
  return leading + "*".repeat(Math.max(0, starCount)) + trailing;
}

export function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Returns {} for a genuinely empty body (some endpoints are called with no
// body at all, e.g. logout) but THROWS on a body that exists and failed to
// parse - previously this swallowed every parse failure into {}, which
// meant a request that failed only because its body was too large (e.g. a
// full-resolution photo as base64, well over Workers' request size limits)
// silently discarded every field in the request instead of surfacing an
// error - "profilePicBase64 didn't come through" with no visible cause,
// matching the reported "image is not being uploaded" symptom exactly.
export async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("অনুরোধের তথ্য পড়া যায়নি (ছবি বা তথ্যের আকার খুব বড় হতে পারে)");
  }
}

export function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}
