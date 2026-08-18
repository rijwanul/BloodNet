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
      `SELECT c.id, c.status, c.cannot_reason, c.created_at, u.username_display as donor_username, u.username_slug as donor_slug, u.id as donor_id
       FROM calls c JOIN users u ON u.id = c.donor_id
       WHERE c.requester_id = ? ORDER BY c.created_at DESC LIMIT 200`
    )
    .bind(user.id)
    .all();

  return ok({
    // No "আপনি/আপনাকে করেছিলেন" self-reference wording per spec; the raw
    // masked number/label and unmodified status are shown plainly.
    received: received.results.map((r) => ({
      id: r.id,
      requesterId: r.requester_id,
      requesterLabel: r.requester_username || maskMobile(r.requester_mobile),
      requesterSlug: r.requester_username || null,
      text: `${maskMobile(r.requester_mobile)} কল করেছিলো। ষ্ট্যাটাস: ${statusLabel(r.status, r.cannot_reason)}`,
      createdAt: r.created_at,
    })),
    made: made.results.map((r) => ({
      id: r.id,
      donorId: r.donor_id,
      donorLabel: r.donor_username || "একজন ডোনার",
      donorSlug: r.donor_slug,
      text: `${r.donor_username || "একজন ডোনার"} কে কল করেছিলেন। ষ্ট্যাটাস: ${statusLabel(r.status, r.cannot_reason)}`,
      createdAt: r.created_at,
    })),
  });
}

// Used by the public profile page's own call-history tab (third-party
// viewer) - identity-revealing but not the same shape as the owner's view.
export async function publicCallHistoryFor(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT c.status, c.cannot_reason, c.created_at, u.mobile as requester_mobile, u.username_display as requester_username, u.id as requester_id
       FROM calls c JOIN users u ON u.id = c.requester_id
       WHERE c.donor_id = ? ORDER BY c.created_at DESC LIMIT 100`
    )
    .bind(userId)
    .all();
  return results.map((r) => ({
    requesterId: r.requester_id,
    requesterLabel: r.requester_username || maskMobile(r.requester_mobile),
    requesterSlug: r.requester_username || null,
    text: `${maskMobile(r.requester_mobile)} কল করেছিলো। ষ্ট্যাটাস: ${statusLabel(r.status, r.cannot_reason)}`,
    createdAt: r.created_at,
  }));
}
