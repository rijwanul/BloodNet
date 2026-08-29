import { err } from "./lib/util.js";
import * as auth from "./handlers/auth.js";
import * as seek from "./handlers/seek.js";
import * as donor from "./handlers/donor.js";
import * as profile from "./handlers/profile.js";
import * as calls from "./handlers/calls.js";
import * as admin from "./handlers/admin.js";
import { runDonationReminderSweep, runActivityLogAutoPurge, runSmsDailyReset, runEligibilityReopenSweep, runEligibilitySnoozeWakeSweep } from "./lib/scheduled.js";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.startsWith("/api/")) {
        return await routeApi(request, env, path);
      }

      // Static assets (css/js/img/etc). Falls through to the SPA shell for
      // any path that isn't a real file - client-side router then decides
      // whether it's a known app route or a /username public profile.
      const assetResp = await env.ASSETS.fetch(request);
      if (assetResp.status !== 404) return assetResp;
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    } catch (e) {
      return err(`সার্ভার সমস্যা: ${String(e && e.message ? e.message : e)}`, 500);
    }
  },

  // Runs on the cron schedule declared in wrangler.toml. Checks for donors
  // who said "can_donate" on a call, still haven't logged/declined a
  // donation 48h later, and haven't already been reminded - then sends the
  // configurable reminder SMS (see lib/scheduled.js).
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDonationReminderSweep(env));
    ctx.waitUntil(runActivityLogAutoPurge(env));
    ctx.waitUntil(runSmsDailyReset(env));
    ctx.waitUntil(runEligibilityReopenSweep(env));
    ctx.waitUntil(runEligibilitySnoozeWakeSweep(env));
  },
};

async function routeApi(request, env, path) {
  const method = request.method;
  const seg = path.split("/").filter(Boolean); // ['api', ...]

  // ---- AUTH ----
  if (path === "/api/auth/check-mobile" && method === "GET") return auth.handleCheckMobile(request, env);
  if (path === "/api/otp/send" && method === "POST") return auth.handleOtpSend(request, env);
  if (path === "/api/auth/register" && method === "POST") return auth.handleRegister(request, env);
  if (path === "/api/auth/login" && method === "POST") return auth.handleLogin(request, env);
  if (path === "/api/auth/logout" && method === "POST") return auth.handleLogout(request, env);
  if (path === "/api/auth/me" && method === "GET") return auth.handleMe(request, env);
  if (path === "/api/auth/forgot-password" && method === "POST") return auth.handleForgotPasswordReset(request, env);
  if (path === "/api/auth/change-password" && method === "POST") return auth.handleChangePassword(request, env);

  // ---- SEEK (রক্ত দরকার) ----
  if (path === "/api/seek/count" && method === "GET") return seek.handleSeekCount(request, env);
  if (path === "/api/seek/state" && method === "GET") return seek.handleSeekState(request, env);
  if (path === "/api/seek/lock" && method === "POST") return seek.handleSeekLock(request, env);
  if (path === "/api/seek/call-status" && method === "POST") return seek.handleSeekCallStatus(request, env);
  if (path === "/api/seek/donor-number" && method === "GET") return seek.handleSeekDonorNumber(request, env);
  if (path === "/api/seek/external-sources" && method === "GET") return seek.handleExternalSources(request, env);

  // ---- DONOR self-service (আমার অবস্থা) ----
  if (path === "/api/donor/status" && method === "GET") return donor.handleDonorStatus(request, env);
  if (path === "/api/donor/dismiss-eligibility-note" && method === "POST") return donor.handleDismissEligibilityNote(request, env);
  if (path === "/api/donor/eligibility" && method === "POST") return donor.handleDonorEligibility(request, env);
  if (path === "/api/donor/dismiss-donation-prompt" && method === "POST") return donor.handleDonorDismissDonationPrompt(request, env);
  if (path === "/api/donor/mode-off" && method === "POST") return donor.handleDonorModeOff(request, env);
  if (path === "/api/donor/note" && method === "POST") return donor.handleDonorNote(request, env);
  if (path === "/api/donor/direct-donation" && method === "POST") return donor.handleDirectDonationEntry(request, env);
  if (path === "/api/donor/check-new-mobile" && method === "GET") return donor.handleDonorCheckNewMobile(request, env);
  if (path === "/api/donor/change-mobile" && method === "POST") return donor.handleDonorChangeMobile(request, env);
  if (path === "/api/donor/change-location" && method === "POST") return donor.handleDonorChangeLocation(request, env);

  // ---- PROFILE ----
  if (path === "/api/profile/me" && method === "GET") return profile.handleProfileMe(request, env);
  if (path === "/api/profile/edit" && method === "PUT") return profile.handleProfileEdit(request, env);
  if (path === "/api/profile/become-donor" && method === "POST") return profile.handleBecomeDonor(request, env);
  if (path === "/api/profile/username/check" && method === "GET") return profile.handleUsernameCheck(request, env);
  if (path === "/api/profile/username" && method === "POST") return profile.handleUsernameClaim(request, env);
  if (path === "/api/profile/visibility" && method === "PUT") return profile.handleProfileVisibility(request, env);
  if (path === "/api/profile/donations" && method === "GET") return profile.handleDonationsList(request, env);
  if (path === "/api/profile/donations" && method === "POST") return profile.handleDonationsAdd(request, env);
  if (seg[2] === "donations" && seg[3] && method === "PUT") return profile.handleDonationEdit(request, env, seg[3]);
  if (seg[2] === "donations" && seg[3] && method === "DELETE") return profile.handleDonationDelete(request, env, seg[3]);
  if (path === "/api/profile/delete" && method === "POST") return profile.handleProfileDelete(request, env);
  if (seg[1] === "u" && seg[2] && method === "GET") return profile.handlePublicProfile(request, env, decodeURIComponent(seg[2]));

  // ---- CALLS ----
  if (path === "/api/calls/history" && method === "GET") return calls.handleCallHistory(request, env);
  if (path === "/api/calls/received-summary" && method === "GET") return calls.handleReceivedCallsSummary(request, env);

  // ---- PUBLIC SETTINGS (site branding, used by every page) ----
  if (path === "/api/settings/public" && method === "GET") return admin.handlePublicSettings(request, env);

  // ---- ADMIN ----
  if (path === "/api/admin/analytics" && method === "GET") return admin.handleAnalytics(request, env);
  if (path === "/api/admin/permissions" && method === "GET") return admin.handlePermissionsList(request, env);

  if (path === "/api/admin/users" && method === "GET") return admin.handleUsersList(request, env);
  if (path === "/api/admin/users" && method === "POST") return admin.handleUserCreate(request, env);
  if (path === "/api/admin/users/import" && method === "POST") return admin.handleUsersImport(request, env);
  if (path === "/api/admin/users/export" && method === "GET") return admin.handleUsersExport(request, env);
  if (path === "/api/admin/users/bulk" && method === "POST") return admin.handleUserBulkAction(request, env);
  if (seg[2] === "users" && seg[3] && method === "PUT") return admin.handleUserUpdate(request, env, seg[3]);
  if (seg[2] === "users" && seg[3] && method === "DELETE") return admin.handleUserDelete(request, env, seg[3]);

  if (path === "/api/admin/sms-settings" && method === "GET") return admin.handleSmsSettingsGet(request, env);
  if (path === "/api/admin/sms-settings" && method === "PUT") return admin.handleSmsSettingsUpdate(request, env);
  if (path === "/api/admin/sms-settings/test" && method === "POST") return admin.handleSmsTest(request, env);

  if (path === "/api/admin/site-apis" && method === "GET") return admin.handleSiteApisGet(request, env);
  if (path === "/api/admin/site-apis" && method === "PUT") return admin.handleSiteApisUpdate(request, env);

  if (path === "/api/admin/site-settings" && method === "GET") return admin.handleSiteSettingsGet(request, env);
  if (path === "/api/admin/site-settings" && method === "PUT") return admin.handleSiteSettingsUpdate(request, env);

  if (path === "/api/admin/locations" && method === "GET") return admin.handleLocationsList(request, env);
  if (path === "/api/admin/locations" && method === "POST") return admin.handleLocationCreate(request, env);
  if (seg[2] === "locations" && seg[3] && method === "PUT") return admin.handleLocationUpdate(request, env, seg[3]);
  if (seg[2] === "locations" && seg[3] && method === "DELETE") return admin.handleLocationDelete(request, env, seg[3]);

  if (path === "/api/admin/external-sources" && method === "GET") return admin.handleExtSourcesList(request, env);
  if (path === "/api/admin/external-sources" && method === "POST") return admin.handleExtSourceCreate(request, env);
  if (seg[2] === "external-sources" && seg[3] && method === "PUT") return admin.handleExtSourceUpdate(request, env, seg[3]);
  if (seg[2] === "external-sources" && seg[3] && method === "DELETE") return admin.handleExtSourceDelete(request, env, seg[3]);

  if (path === "/api/admin/activity-log" && method === "GET") return admin.handleActivityLog(request, env);
  if (path === "/api/admin/activity-log/purge" && method === "POST") return admin.handleActivityLogPurge(request, env);
  if (path === "/api/admin/activity-log/auto-purge" && method === "GET") return admin.handleActivityLogPurgeScheduleGet(request, env);
  if (path === "/api/admin/activity-log/auto-purge" && method === "PUT") return admin.handleActivityLogPurgeScheduleUpdate(request, env);
  if (path === "/api/admin/sms-analytics" && method === "GET") return admin.handleSmsAnalyticsGet(request, env);
  if (path === "/api/admin/sms-analytics/reset" && method === "POST") return admin.handleSmsAnalyticsReset(request, env);
  if (path === "/api/admin/sms-limit-override" && method === "POST") return admin.handleSmsLimitOverride(request, env);
  if (path === "/api/admin/claim-unregistered-donorbd-slugs" && method === "POST") return admin.handleClaimUnregisteredDonorbdSlugs(request, env);

  // Public locations list is also used outside admin (signup forms etc.)
  if (path === "/api/locations" && method === "GET") return admin.handleLocationsList(request, env);
  if (path === "/api/external-sources" && method === "GET") return admin.handleExtSourcesList(request, env);

  return err("Not found", 404);
}
