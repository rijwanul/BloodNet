export const STATUS_LABELS_BN = {
  pending: "আপডেট করা হয়নি",
  no_answer: "কল যাচ্ছে না",
  not_picked_up: "কল ধরেননি",
  cannot_donate: "রক্ত দিতে পারবেন না",
  can_donate: "রক্ত দিতে পারবেন",
  not_called: "কল করিনি",
};

export const CANNOT_REASON_LABELS_BN = {
  not_yet_eligible: "রক্ত দেওয়ার সময় হয়নি",
  far_away: "দূরে আছেন",
  busy_today: "আজকে ব্যস্ত",
  no_reason_given: "কারণ জানান নি",
};

// Sub-reasons for "কল করিনি" (not_called) - a separate reason set from
// CANNOT_REASON_LABELS_BN above since the question being answered is
// different ("কেন কল করেননি?" vs "কেন রক্ত দিতে পারবেন না?").
// "other" ("অন্যান্য") is a normal fixed reason like the first two - no
// text required. "কাষ্টম ব্যখ্যা" is the separate free-text option (up to
// 30 chars, enforced both in the frontend input's maxlength and
// server-side in seek.js) - it has NO fixed key here since its value is
// whatever the requester typed, stored as-is in the same cannot_reason
// column as the fixed keys. Callers should check
// NOT_CALLED_REASON_LABELS_BN[key] first and fall back to displaying the
// stored value as-is when it's custom text (i.e. not one of these keys).
export const NOT_CALLED_REASON_LABELS_BN = {
  note_reason: "নোটের কারণে",
  blood_not_needed: "রক্ত প্রয়োজন নেই",
  other: "অন্যান্য",
};

// Statuses whose reason code should be shown suffixed in parentheses -
// cannot_donate uses CANNOT_REASON_LABELS_BN, not_called uses
// NOT_CALLED_REASON_LABELS_BN (falling back to the raw stored value for a
// custom "other" message, since that isn't a key in either label map).
export function statusLabel(status, cannotReason) {
  let t = STATUS_LABELS_BN[status] || status;
  if (status === "cannot_donate" && cannotReason) {
    t += ` (${CANNOT_REASON_LABELS_BN[cannotReason] || cannotReason})`;
  } else if (status === "not_called" && cannotReason) {
    t += ` (${NOT_CALLED_REASON_LABELS_BN[cannotReason] || cannotReason})`;
  }
  return t;
}
