// Granular admin permission keys. Every admin (except the root admin) is
// granted a subset of these via users.permissions_json.
// The root admin (is_root_admin = 1) always has full access implicitly.

export const PERMISSIONS = [
  { key: "manage_users", label: "ইউজার ম্যানেজমেন্ট (Add/Edit/Delete/Import/Export)" },
  { key: "manage_sms_settings", label: "এসএমএস সেটিংস" },
  { key: "manage_site_apis", label: "সাইট এপিআই (ImgBB, GreenSMS, DonorBD)" },
  { key: "manage_locations", label: "লোকেশন লিস্ট" },
  { key: "manage_external_sources", label: "এক্সটার্নাল সোর্সেস" },
  { key: "view_activity_log", label: "এক্টিভিটি লগ দেখা" },
  { key: "manage_site_settings", label: "সাইট সেটিংস (টাইটেল, লোগো, থিম, ওয়েলকাম মেসেজ ইত্যাদি)" },
  { key: "manage_telegram_bots", label: "টেলিগ্রাম বটস ও লগ" },
];

export function hasPermission(user, key) {
  if (!user) return false;
  if (user.is_root_admin) return true;
  if (!user.is_admin) return false;
  try {
    const perms = JSON.parse(user.permissions_json || "[]");
    return perms.includes(key);
  } catch {
    return false;
  }
}

export function isAnyAdmin(user) {
  return !!(user && (user.is_admin || user.is_root_admin));
}
