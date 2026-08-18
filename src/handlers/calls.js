import { ok, err, maskMobile } from "../lib/util.js";
import { getCurrentUser } from "../lib/authctx.js";

const STATUS_LABELS = {
  pending: "আপডেট করা হয়নি",
  no_answer: "কল যাচ্ছে না",
  not_picked_up: "কল ধরেননি",
  cannot_donate: "রক্ত দিতে পারবেন না",
  can_donate: "রক্ত দিতে পেরেছেন",
};
const REASON_LABELS = {
  not_yet_eligible: "রক্ত দেওয়ার সময় হয়নি",
  far_away: "দূরে আছেন",
  busy_today: "আজকে ব্যস্ত",
  no_reason_given: "কারণ জানান নি",
};

function statusText(status, reason) {
  let t = STATUS_LABELS[status] || status;
  if (status === "cannot_donate" && reason) t += ` (${REASON_LABELS[reason] || reason})`;
  return t;
}

export async function handleCallHistory(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err("লগইন প্রয়োজন", 401);

  const received = await env.DB
    .prepare(
      `SELECT c.id, c.status, c.cannot_reason, c.created_at, u.mobile as requester_mobile
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
    received: received.results.map((r) => ({
      id: r.id,
      text: `আপনাকে ${maskMobile(r.requester_mobile)} কল করেছিলো। ষ্ট্যাটাস: ${statusText(r.status, r.cannot_reason)}`,
      createdAt: r.created_at,
    })),
    made: made.results.map((r) => ({
      id: r.id,
      donorLabel: r.donor_username || `donor-${r.donor_id}`,
      donorSlug: r.donor_slug,
      text: `আপনি ${r.donor_username || "একজন ডোনার"} কে কল করেছিলেন। ষ্ট্যাটাস: ${statusText(r.status, r.cannot_reason)}`,
      createdAt: r.created_at,
    })),
  });
}
