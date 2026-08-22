import { getSettings, setSettings } from "./settings.js";
import { sendNotificationSms, fillTemplate } from "./sms.js";
import { logActivity } from "./activity.js";
import { wakeSnoozedDonors } from "../handlers/seek.js";

// Runs the same wake-up sweep that already happens lazily on every
// search/profile view (see seek.js/profile.js), but on a schedule - so a
// donor whose snooze period ends isn't stuck showing "স্বয়ংক্রিয়ভাবে চালু
// হবে" indefinitely just because nobody happened to search for donors or
// visit a profile page after their timer ran out.
export async function runSnoozeWakeSweep(env) {
  await wakeSnoozedDonors(env.DB);
}

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
    const msg = fillTemplate(settings.sms_donation_reminder, { siteTitle: settings.site_title || "BloodNet v2" }, settings);
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

// If auto-purge is enabled, deletes activity_log rows older than the
// admin-configured cutoff. Kept as its own function (not folded into
// runDonationReminderSweep) so worker.js can wrap each independently -
// a failure in one sweep shouldn't stop the other from running.
export async function runActivityLogAutoPurge(env) {
  const settings = await getSettings(env.DB);
  if (settings.activity_log_auto_purge_enabled !== "1") return;
  const days = parseInt(settings.activity_log_auto_purge_days, 10) || 30;
  const result = await env.DB.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', ?)").bind(`-${days} days`).run();
  if (result.meta.changes > 0) {
    await logActivity(env.DB, {
      category: "system",
      actionText: `স্বয়ংক্রিয় এক্টিভিটি লগ পার্জ সম্পন্ন হয়েছে (${days} দিনের পুরনো, ${result.meta.changes}টি এন্ট্রি মুছে ফেলা হয়েছে)`,
    });
  }
}

// Daily reset of the two SMS counters - the primary mechanism (the lazy
// per-request check in sms.js's checkAndBumpSmsLimit is a safety net for
// gaps between scheduled runs, not a substitute for this). Also handles
// the monthly automatic reset of the highest-daily-SMS record: if the
// calendar month has changed since sms_highest_daily_reset_month, every
// user's current record is archived into sms_daily_record_history and
// their live record cleared, exactly like a manual admin reset would do.
export async function runSmsDailyReset(env) {
  const settings = await getSettings(env.DB);
  const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  if ((settings.sms_highest_daily_reset_month || "") !== currentMonth) {
    await archiveAndClearSmsRecords(env.DB);
    await setSettings(env.DB, { sms_highest_daily_reset_month: currentMonth });
  }
  // Counters themselves are reset lazily per-user on their next SMS (see
  // checkAndBumpSmsLimit's sms_count_date check) rather than a bulk UPDATE
  // here - a bulk UPDATE across every user row daily is unnecessary write
  // volume when the lazy check already guarantees correctness.
}

async function archiveAndClearSmsRecords(db) {
  const { results } = await db.prepare("SELECT id, mobile, sms_highest_daily_count, sms_highest_daily_date FROM users WHERE sms_highest_daily_count > 0").all();
  for (const u of results) {
    await db
      .prepare("INSERT INTO sms_daily_record_history (mobile, count, record_date) VALUES (?, ?, ?)")
      .bind(u.mobile, u.sms_highest_daily_count, u.sms_highest_daily_date)
      .run();
  }
  await db.prepare("UPDATE users SET sms_highest_daily_count = 0, sms_highest_daily_date = NULL").run();
}
