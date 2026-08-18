import { getSettings } from "./settings.js";
import { sendNotificationSms, fillTemplate } from "./sms.js";
import { logActivity } from "./activity.js";

// Finds donors who said "can_donate" on a call (pending_donation_prompt=1),
// where 48h have passed since that prompt and no reminder has been sent
// yet for it, and sends the configurable reminder SMS. Runs on whatever
// cron schedule is set in wrangler.toml (e.g. hourly).
export async function runDonationReminderSweep(env) {
  const settings = await getSettings(env.DB);
  if (settings.sms_enabled_donation_reminder === "0") return;

  const { results } = await env.DB
    .prepare(
      `SELECT id, mobile FROM users
       WHERE deleted = 0 AND pending_donation_prompt = 1 AND donation_reminder_sent = 0
         AND pending_donation_prompt_at IS NOT NULL
         AND pending_donation_prompt_at <= datetime('now', '-48 hours')`
    )
    .all();

  for (const donor of results) {
    const msg = fillTemplate(settings.sms_donation_reminder, { siteTitle: settings.site_title || "BloodNet v2" });
    const result = await sendNotificationSms(env.DB, settings, donor.mobile, msg, "donation_reminder");
    await env.DB.prepare("UPDATE users SET donation_reminder_sent = 1 WHERE id = ?").bind(donor.id).run();
    if (result.sent) {
      await logActivity(env.DB, {
        category: "system",
        actionText: `৪৮ ঘন্টা পর রক্তদান রিমাইন্ডার এসএমএস পাঠানো হয়েছে: ${donor.mobile}`,
      });
    }
  }
}
