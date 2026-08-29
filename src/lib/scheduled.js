import { getSettings, setSettings } from "./settings.js";
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

// Reminds a donor who manually turned eligibility OFF (not 'snoozed' -
// that auto-resuming state is handled by runEligibilitySnoozeWakeSweep
// below) that they're free to turn it back on, once ALL of these hold:
//  1. eligibility_status = 'off' (a deliberate choice, not a temporary pause)
//  2. last_donation_date is older than the site's wait timeline
//     (settings.eligibility_wait_months)
//  3. they turned it off at least eligibility_reopen_delay_days ago (admin-
//     configurable, default 15) - so someone who JUST turned it off
//     manually isn't immediately nagged, even if their last donation
//     already happens to be old enough
//  4. no reopen-reminder was sent to them in the last
//     eligibility_reopen_repeat_days (admin-configurable, default 15) -
//     repeat-suppression so this doesn't re-send every sweep run
// This is notification-only - it does NOT flip eligibility_status back to
// 'on' automatically. 'off' was a deliberate choice; the donor decides.
// eligibility_off_since is stamped only when a donor chooses indefinite
// "off" themselves (see donor.js) - never for the temporary snooze states,
// and cleared whenever they turn eligibility on again or stop being a
// donor entirely (both of which also take them out of this query's WHERE
// clause, is_donor=1 AND eligibility_status='off').
export async function runEligibilityReopenSweep(env) {
  const settings = await getSettings(env.DB);
  if (settings.sms_enabled_eligibility_reopened === "0") return;
  const waitMonths = parseInt(settings.eligibility_wait_months, 10) || 3;
  const delayDays = parseInt(settings.eligibility_reopen_delay_days, 10) || 15;
  const repeatDays = parseInt(settings.eligibility_reopen_repeat_days, 10) || 15;

  const { results } = await env.DB
    .prepare(
      `SELECT id, mobile FROM users
       WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'off'
         AND last_donation_date IS NOT NULL
         AND date(last_donation_date, '+' || ? || ' months') <= date('now')
         AND eligibility_off_since IS NOT NULL
         AND datetime(eligibility_off_since, '+' || ? || ' days') <= datetime('now')
         AND (eligibility_reopen_note_sent_at IS NULL OR datetime(eligibility_reopen_note_sent_at, '+' || ? || ' days') <= datetime('now'))`
    )
    .bind(waitMonths, delayDays, repeatDays)
    .all();

  for (const donor of results) {
    const msg = fillTemplate(settings.sms_eligibility_reopened, { siteTitle: settings.site_title || "BloodNet v2" }, settings);
    const result = await sendNotificationSms(env.DB, settings, donor.mobile, msg, "eligibility_reopened");
    // Timestamp is recorded regardless of send success/failure - a
    // provider outage shouldn't cause a burst of retries every sweep
    // tick; the next attempt naturally waits out the same repeat window.
    await env.DB.prepare("UPDATE users SET eligibility_reopen_note_sent_at = datetime('now') WHERE id = ?").bind(donor.id).run();
    if (result.sent) {
      await logActivity(env.DB, {
        category: "system",
        actionText: `রক্তদানের এলিজিবিলিটি পুনরায় চালুর রিমাইন্ডার এসএমএস পাঠানো হয়েছে: ${donor.mobile}`,
      });
    }
  }
}

// Trigger 2: donors whose 'snoozed' status just auto-expired (their
// eligibility_snooze_until has passed). Unlike Trigger 1, this DOES flip
// them to 'on' - a snooze was always meant to auto-resume (that's the
// whole point of the temporary states: today_off/2h/6h/until_date), so
// there's no "should we really turn this on" judgment call being made
// here, just notifying them it happened. The reactive per-request wake in
// seek.js's wakeSnoozedDonors() still runs too (so search results are
// correct immediately rather than waiting for the next cron tick) - that
// one deliberately stays silent (bulk UPDATE, no per-row loop, no SMS) so
// a requester's search never triggers an SMS send as a side effect; THIS
// sweep is what actually sends the notification, on its own schedule.
export async function runEligibilitySnoozeWakeSweep(env) {
  const settings = await getSettings(env.DB);
  const { results } = await env.DB
    .prepare(
      `SELECT id, mobile FROM users
       WHERE deleted = 0 AND is_donor = 1 AND eligibility_status = 'snoozed'
         AND eligibility_snooze_until IS NOT NULL AND eligibility_snooze_until <= datetime('now')`
    )
    .all();

  for (const donor of results) {
    await env.DB
      .prepare("UPDATE users SET eligibility_status = 'on', eligibility_snooze_until = NULL, eligibility_snooze_reason = NULL WHERE id = ?")
      .bind(donor.id)
      .run();
    if (settings.sms_enabled_eligibility_reopened !== "0") {
      const msg = fillTemplate(settings.sms_eligibility_reopened, { siteTitle: settings.site_title || "BloodNet v2" }, settings);
      const result = await sendNotificationSms(env.DB, settings, donor.mobile, msg, "eligibility_reopened");
      if (result.sent) {
        await logActivity(env.DB, {
          category: "system",
          actionText: `স্থগিত-শেষে এলিজিবিলিটি চালু হওয়ার নোটিফিকেশন এসএমএস পাঠানো হয়েছে: ${donor.mobile}`,
        });
      }
    }
  }
}
