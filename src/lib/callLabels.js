export const STATUS_LABELS_BN = {
  pending: "আপডেট করা হয়নি",
  no_answer: "কল যাচ্ছে না",
  not_picked_up: "কল ধরেননি",
  cannot_donate: "রক্ত দিতে পারবেন না",
  can_donate: "রক্ত দিতে পারবেন",
};

export const CANNOT_REASON_LABELS_BN = {
  not_yet_eligible: "রক্ত দেওয়ার সময় হয়নি",
  far_away: "দূরে আছেন",
  busy_today: "আজকে ব্যস্ত",
  no_reason_given: "কারণ জানান নি",
};

export function statusLabel(status, cannotReason) {
  let t = STATUS_LABELS_BN[status] || status;
  if (status === "cannot_donate" && cannotReason) t += ` (${CANNOT_REASON_LABELS_BN[cannotReason] || cannotReason})`;
  return t;
}
