import { ok, err, maskMobile } from "../lib/util.js";
import { getCurrentUser } from "../lib/authctx.js";
import { statusLabel } from "../lib/callLabels.js";
import { getSettings } from "../lib/settings.js";

// Full call history (site-wide /calls page): every call this user was
// involved in, either direction, newest first. Each row names BOTH
// parties explicitly - "requester (masked) কল করেছিলো donor (masked) কে"
// - since with only one side named it was unclear who called whom,
// especially once both people have short generic-looking usernames.
export async function handleReceivedCallsSummary(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const settings = await getSettings(env.DB);
  const calls = await receivedCallsSummaryFor(env.DB, user.id, settings);
  // Aggregate counters shown above the list per spec: total calls made,
  // total calls received, how many times a status was never given, and how
  // many times the donor specifically "কল ধরেননি" (not_picked_up) -
  // "কল যাচ্ছে না" (no_answer) explicitly does NOT count toward this one,
  // since that status means the call didn't go through at all rather than
  // being picked up and ignored.
  const [madeCount, receivedCount, notUpdatedCount, notPickedUpCount] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) c FROM calls WHERE requester_id = ?").bind(user.id).first(),
    env.DB.prepare("SELECT COUNT(*) c FROM calls WHERE donor_id = ?").bind(user.id).first(),
    env.DB.prepare("SELECT COUNT(*) c FROM calls WHERE donor_id = ? AND status = 'pending'").bind(user.id).first(),
    env.DB.prepare("SELECT COUNT(*) c FROM calls WHERE donor_id = ? AND status = 'not_picked_up'").bind(user.id).first(),
  ]);
  return ok({
    calls,
    totalCallsMade: madeCount.c,
    totalCallsReceived: receivedCount.c,
    totalNotUpdated: notUpdatedCount.c,
    totalNotPickedUp: notPickedUpCount.c,
  });
}

export async function handleCallHistory(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);
  const settings = await getSettings(env.DB);

  const { results } = await env.DB
    .prepare(
      `SELECT c.id, c.status, c.cannot_reason, c.created_at, c.requester_id, c.donor_id,
              ru.mobile as requester_mobile, ru.username_display as requester_username, ru.username_slug as requester_slug,
              du.mobile as donor_mobile, du.username_display as donor_username, du.username_slug as donor_slug
       FROM calls c
       JOIN users ru ON ru.id = c.requester_id
       JOIN users du ON du.id = c.donor_id
       WHERE c.requester_id = ? OR c.donor_id = ?
       ORDER BY c.created_at DESC LIMIT 200`
    )
    .bind(user.id, user.id)
    .all();

  return ok({ calls: results.map((r) => shapeCallRow(r, settings)) });
}

// Row shape shared by the full /calls page and the profile tab's
// received-only, last-5 list. requesterLabel/donorLabel are each meant to
// be individually hyperlinked by the frontend (two separate <a> tags, not
// one combined one) - "requester (মাস্কড) কল করেছিলো donor (মাস্কড) কে।
// ষ্ট্যাটাস: donor-username status-phrase".
function shapeCallRow(r, settings) {
  const requesterLabel = personLabelWithNumber(r.requester_username, r.requester_mobile, settings);
  const donorLabel = personLabelWithNumber(r.donor_username, r.donor_mobile, settings);
  const donorNameOnly = r.donor_username || maskMobile(r.donor_mobile, settings);
  return {
    id: r.id,
    requesterId: r.requester_id,
    donorId: r.donor_id,
    requesterLabel,
    requesterSlug: r.requester_slug || null,
    donorLabel,
    donorSlug: r.donor_slug || null,
    status: r.status,
    // Full third-party sentence (used as-is on the profile tab, which
    // always shows OTHER people's view of a call): "requester (masked)
    // কল করেছিলো donor (masked) কে। ষ্ট্যাটাস: donor-username <phrase>" -
    // donorNameOnly (not the full donorLabel-with-number) is used in the
    // status clause since repeating the masked number there is redundant
    // once already shown once in donorLabel just before it.
    statusText: `ষ্ট্যাটাস: ${donorNameOnly} ${statusPhraseFor(r.status, r.cannot_reason)}`,
    // Just the phrase with no name/prefix - used by the site-wide /calls
    // page's own-perspective phrasing ("আপনি ... ষ্ট্যাটাস: <phrase>" /
    // "আপনাকে ... ষ্ট্যাটাস জানিয়েছে: <phrase>"), which builds its own
    // sentence around this rather than reusing the third-party statusText.
    statusPhrase: statusPhraseFor(r.status, r.cannot_reason),
    createdAt: r.created_at,
  };
}

// statusLabel() gives a short label like "কল ধরেননি" or "রক্ত দিতে পারবে
// না (দূরে আছেন)" - used here as-is after the donor's name, matching the
// spec's example phrasing exactly ("... donor-username কল ধরেননি").
function statusPhraseFor(status, cannotReason) {
  return statusLabel(status, cannotReason);
}

// "username (013******90)" when a username is claimed, otherwise just the
// masked number on its own - either way this whole string is meant to be
// wrapped in a hyperlink by the caller. Mask width is admin-configurable
// (settings.mask_visible_digits, default 4 visible at the end - matching
// the existing default example "013******34").
function personLabelWithNumber(username, mobile, settings) {
  const masked = maskMobile(mobile, settings);
  if (username) return `${username} (${masked})`;
  return masked;
}

// Used by the public profile page's own call-history tab (third-party
// viewer) - only calls RECEIVED by this donor, never calls they placed to
// others (a visitor to a donor's profile has no business seeing who that
// donor called elsewhere).
export async function publicCallHistoryFor(db, userId, settings) {
  const { results } = await db
    .prepare(
      `SELECT c.status, c.cannot_reason, c.created_at, u.mobile as requester_mobile, u.username_display as requester_username, u.username_slug as requester_slug, u.id as requester_id
       FROM calls c JOIN users u ON u.id = c.requester_id
       WHERE c.donor_id = ? ORDER BY c.created_at DESC LIMIT 100`
    )
    .bind(userId)
    .all();
  return results.map((r) => ({
    requesterId: r.requester_id,
    personLabel: personLabelWithNumber(r.requester_username, r.requester_mobile, settings),
    slug: r.requester_slug || null,
    suffixText: `কল করেছিলো। ষ্ট্যাটাস: ${statusLabel(r.status, r.cannot_reason)}`,
    createdAt: r.created_at,
  }));
}

// Profile tab's own "calls" section: RECEIVED calls only (as a donor),
// newest first, capped at 5 - a compact recent-activity summary rather
// than the full history (which lives on the site-wide /calls page).
export async function receivedCallsSummaryFor(db, userId, settings) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.status, c.cannot_reason, c.created_at, c.requester_id, c.donor_id,
              ru.mobile as requester_mobile, ru.username_display as requester_username, ru.username_slug as requester_slug,
              du.mobile as donor_mobile, du.username_display as donor_username
       FROM calls c
       JOIN users ru ON ru.id = c.requester_id
       JOIN users du ON du.id = c.donor_id
       WHERE c.donor_id = ? ORDER BY c.created_at DESC LIMIT 5`
    )
    .bind(userId)
    .all();
  return results.map((r) => shapeCallRow(r, settings));
}
