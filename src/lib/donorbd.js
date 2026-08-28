// Client for the donor.bd central donor-username system.
// Auth: Authorization: Bearer <donorbd_api_key>
import { genUniqueRandomSlug, getReservedSlugSet } from "./util.js";

async function call(baseUrl, apiKey, path, body) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { ok: res.ok, status: res.status, data };
}

export async function donorbdCheckAvailability(settings, slug) {
  const { donorbd_base_url: baseUrl, donorbd_api_key: apiKey } = settings;
  if (!baseUrl || !apiKey) return { configured: false, available: true };
  const { ok, data } = await call(baseUrl, apiKey, "/api/checkAvailability", { slug });
  return { configured: true, available: ok && data && data.available !== false };
}

export async function donorbdNewEntry(settings, { target, slug }) {
  const { donorbd_base_url: baseUrl, donorbd_api_key: apiKey } = settings;
  if (!baseUrl || !apiKey) return { configured: false, ok: true };
  const { ok, data } = await call(baseUrl, apiKey, "/api/newEntry", {
    target,
    slug,
    fullIframe: false,
    socialEnabled: false,
  });
  return { configured: true, ok, data };
}

export async function donorbdDeleteEntry(settings, slug) {
  const { donorbd_base_url: baseUrl, donorbd_api_key: apiKey } = settings;
  if (!baseUrl || !apiKey) return { configured: false, ok: true };
  const { ok, data } = await call(baseUrl, apiKey, "/api/deleteEntry", { slug });
  return { configured: true, ok, data };
}

// Generates a unique random 6-char slug (see genUniqueRandomSlug) and also
// claims it in donor.bd, in one call - used by every account-creation path
// (self-registration, admin-create, CSV import) that assigns a random
// username, so a fresh account is registered on donor.bd from the moment
// it exists rather than only once someone manually claims a username.
// Returns { slug, donorbdRegistered } - donorbdRegistered is true only
// when donor.bd is configured AND the registration actually succeeded;
// the local account creation itself never fails because of a donor.bd
// hiccup, it just leaves donorbd_slug_registered = 0 for the admin sweep
// (see claimUnregisteredDonorbdSlugs) to retry later.
export async function genAndClaimRandomSlug(db, settings, baseUrl) {
  const reserved = await getReservedSlugSet(db);
  const slug = await genUniqueRandomSlug(db, reserved);
  const entryResult = await donorbdNewEntry(settings, { target: `${baseUrl}/${slug}`, slug: slug.toLowerCase() }).catch(() => ({ configured: false, ok: false }));
  return { slug, donorbdRegistered: entryResult.configured && entryResult.ok };
}

// Admin sweep: finds every donor/user whose current username_slug either
// doesn't exist yet or exists locally but was never successfully
// registered on donor.bd (donorbd_slug_registered = 0), and for each one:
//  1. If they already have a local slug, try claiming THAT exact slug on
//     donor.bd first (don't invent a new one if the existing one is fine).
//  2. If they have no local slug, or their existing slug isn't available
//     on donor.bd (someone else already holds it there), generate a fresh
//     unique random slug and claim that instead.
// Returns a summary the admin UI can show: how many were fixed, how many
// still failed (e.g. donor.bd unreachable), and per-user detail lines.
export async function claimUnregisteredDonorbdSlugs(db, settings, baseUrl) {
  if (!settings.donorbd_base_url || !settings.donorbd_api_key) {
    return { configured: false, fixed: 0, failed: 0, details: [] };
  }
  const { results } = await db
    .prepare("SELECT id, mobile, username_slug, username_display FROM users WHERE deleted = 0 AND (username_slug IS NULL OR donorbd_slug_registered = 0)")
    .all();

  let fixed = 0;
  let failed = 0;
  const details = [];
  const reserved = await getReservedSlugSet(db);

  for (const u of results) {
    let slugToClaim = u.username_slug;

    if (slugToClaim) {
      const avail = await donorbdCheckAvailability(settings, slugToClaim.toLowerCase());
      if (!avail.available) slugToClaim = null; // someone else holds it on donor.bd - fall through to generating a new one
    }

    if (!slugToClaim) {
      slugToClaim = await genUniqueRandomSlug(db, reserved);
    }

    const entryResult = await donorbdNewEntry(settings, { target: `${baseUrl}/${slugToClaim}`, slug: slugToClaim.toLowerCase() }).catch(() => ({ configured: false, ok: false }));
    if (entryResult.ok) {
      await db
        .prepare("UPDATE users SET username_slug = ?, username_display = ?, donorbd_slug_registered = 1, updated_at = datetime('now') WHERE id = ?")
        .bind(slugToClaim.toLowerCase(), slugToClaim, u.id)
        .run();
      fixed++;
      details.push({ mobile: u.mobile, slug: slugToClaim, ok: true });
    } else {
      failed++;
      details.push({ mobile: u.mobile, slug: slugToClaim, ok: false });
    }
  }

  return { configured: true, fixed, failed, details };
}
