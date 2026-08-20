// All ephemeral, self-expiring state (OTP codes, donor call-locks, per
// requester rate-limit windows) lives in KV rather than D1.

const OTP_TTL_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;

export async function storeOtp(kv, purpose, mobile, code) {
  const key = `otp:${purpose}:${mobile}`;
  await kv.put(key, JSON.stringify({ code, attempts: 0 }), { expirationTtl: OTP_TTL_SECONDS });
}

// Returns 'ok' | 'invalid' | 'expired' | 'too_many_attempts'
export async function verifyOtp(kv, purpose, mobile, code, overrideCode = null) {
  if (overrideCode) {
    // Manual/fixed admin OTP mode - no KV state needed at all.
    return code === overrideCode ? "ok" : "invalid";
  }
  const key = `otp:${purpose}:${mobile}`;
  const raw = await kv.get(key);
  if (!raw) return "expired";
  const data = JSON.parse(raw);
  if (data.attempts >= OTP_MAX_ATTEMPTS) {
    await kv.delete(key);
    return "too_many_attempts";
  }
  if (data.code !== code) {
    data.attempts += 1;
    await kv.put(key, JSON.stringify(data), { expirationTtl: OTP_TTL_SECONDS });
    return "invalid";
  }
  await kv.delete(key);
  return "ok";
}

// --- Donor call-lock: keeps a requester pinned to the same donor while a
// call is in progress instead of re-rolling a new one on every refresh.
// Scoped per (requester, bloodGroup) - a requester can be mid-call with a
// B+ donor and simultaneously start a fresh A+ search without either one
// disturbing the other, and switching blood groups back and forth can't be
// used to dodge the same-donor exclusion within a single group's session. ---
export async function getLock(kv, requesterId, bloodGroup) {
  const raw = await kv.get(`lock:${requesterId}:${bloodGroup}`);
  return raw ? JSON.parse(raw) : null;
}

export async function setLock(kv, requesterId, donorId, minutes, bloodGroup) {
  const ttl = Math.max(60, Math.round(minutes * 60));
  await kv.put(
    `lock:${requesterId}:${bloodGroup}`,
    JSON.stringify({ donorId, bloodGroup, lockedAt: Date.now(), expiresAt: Date.now() + ttl * 1000 }),
    { expirationTtl: ttl }
  );
}

export async function clearLock(kv, requesterId, bloodGroup) {
  await kv.delete(`lock:${requesterId}:${bloodGroup}`);
}

// Used only where the caller doesn't know which group's lock is relevant
// yet (e.g. resolving a donor-number request purely from donorId) - scans
// the 8 possible per-group keys for this requester and returns whichever
// one currently points at this donor, or null if none do.
export async function findLockForDonor(kv, requesterId, donorId, bloodGroups) {
  for (const bg of bloodGroups) {
    const lock = await getLock(kv, requesterId, bg);
    if (lock && lock.donorId === donorId) return lock;
  }
  return null;
}

// --- Rolling call-rate limit per requester (e.g. 20 calls / 15 min) ---
export async function checkAndBumpRateLimit(kv, requesterId, limitCount, windowMinutes) {
  const key = `ratelimit:${requesterId}`;
  const raw = await kv.get(key);
  const now = Date.now();
  let state = raw ? JSON.parse(raw) : { count: 0, windowStart: now };
  const windowMs = windowMinutes * 60 * 1000;
  if (now - state.windowStart > windowMs) {
    state = { count: 0, windowStart: now };
  }
  if (state.count >= limitCount) {
    const retryAfterMs = windowMs - (now - state.windowStart);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  state.count += 1;
  await kv.put(key, JSON.stringify(state), { expirationTtl: Math.ceil(windowMs / 1000) + 5 });
  return { allowed: true, remaining: limitCount - state.count };
}
