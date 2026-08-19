import { ok, err, maskMobile } from "../lib/util.js";
import { getCurrentUser } from "../lib/authctx.js";
import { statusLabel } from "../lib/callLabels.js";

export async function handleCallHistory(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);

  const received = await env.DB
    .prepare(
      `SELECT c.id, c.status, c.cannot_reason, c.created_at, u.mobile as requester_mobile,
              u.id as requester_id, u.username_display as requester_username
       FROM calls c JOIN users u ON u.id = c.requester_id
       WHERE c.donor_id = ? ORDER BY c.created_at DESC LIMIT 200`
    )
    .bind(user.id)
    .all();

  const made = await env.DB
    .prepare(
      `SELECT c.id, c.status, c.cannot_reason, c.created_at, u.mobile as donor_mobile, u.username_display as donor_username, u.username_slug as donor_slug, u.id as donor_id
       FROM calls c JOIN users u ON u.id = c.donor_id
       WHERE c.requester_id = ? ORDER BY c.created_at DESC LIMIT 200`
    )
    .bind(user.id)
    .all();

  return ok({
    // personLabel is always "username (masked-number)" when a username
    // exists, or just the masked number when it doesn't - the frontend
    // wraps the whole personLabel in one hyperlink and appends suffixText
    // (the "কে কল করেছিলেন। ষ্ট্যাটাস: ..." part) unlinked, outside the <a>.
    // No "আপনি/আপনাকে করেছিলেন" self-reference wording per spec.
    received: received.results.map((r) => ({
      id: r.id,
      requesterId: r.requester_id,
      personLabel: personLabelWithNumber(r.requester_username, r.requester_mobile),
      slug: r.requester_username || null,
      suffixText: `কল করেছিলো। ষ্ট্যাটাস: ${statusLabel(r.status, r.cannot_reason)}`,
      createdAt: r.created_at,
    })),
    made: made.results.map((r) => ({
      id: r.id,
      donorId: r.donor_id,
      personLabel: personLabelWithNumber(r.donor_username, r.donor_mobile),
      slug: r.donor_slug,
      suffixText: `কে কল করেছিলেন। ষ্ট্যাটাস: ${statusLabel(r.status, r.cannot_reason)}`,
      createdAt: r.created_at,
    })),
  });
}

// "username (013******90)" when a username is claimed, otherwise just the
// masked number on its own - either way this whole string is meant to be
// wrapped in a single hyperlink by the caller.
function personLabelWithNumber(username, mobile) {
  const masked = maskMobile(mobile);
  if (username) return `${username} (${masked})`;
  return masked;
}

// Used by the public profile page's own call-history tab (third-party
// viewer) - identity-revealing but not the same shape as the owner's view.
export async function publicCallHistoryFor(db, userId) {
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
    personLabel: personLabelWithNumber(r.requester_username, r.requester_mobile),
    slug: r.requester_slug || null,
    suffixText: `কল করেছিলো। ষ্ট্যাটাস: ${statusLabel(r.status, r.cannot_reason)}`,
    createdAt: r.created_at,
  }));
}
