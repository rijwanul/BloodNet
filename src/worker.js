import { err, isValidBloodGroup } from "./lib/util.js";
import * as auth from "./handlers/auth.js";
import * as seek from "./handlers/seek.js";
import * as donor from "./handlers/donor.js";
import * as profile from "./handlers/profile.js";
import * as calls from "./handlers/calls.js";
import * as admin from "./handlers/admin.js";
import { getBrandForHostname } from "./handlers/admin.js";
import { getSettings } from "./lib/settings.js";
import { runDonationReminderSweep, runActivityLogAutoPurge, runSmsDailyReset, runEligibilityReopenSweep, runEligibilitySnoozeWakeSweep } from "./lib/scheduled.js";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.startsWith("/api/")) {
        return await routeApi(request, env, path);
      }

      // Static assets (css/js/img/etc) are served as-is. HTML documents -
      // whether the asset binding matches "/" directly, or falls through to
      // the SPA shell for an unknown path (client-side router then decides
      // if it's a known app route or a /username public profile) - always
      // get run through applyServerSideBranding so the <title>/favicon
      // reflect the CURRENT site settings (or a matching multisite brand)
      // instead of the hardcoded defaults baked into the static index.html
      // file. Previously this only happened on the SPA-fallback path, which
      // with not_found_handling = "single-page-application" essentially
      // never fires for a normal "/" load - assetResp already resolves
      // index.html directly and was returned unmodified, which is why the
      // static "BloodNet v2" title/favicon would flash regardless of what
      // was set in site settings.
      const assetResp = await env.ASSETS.fetch(request);
      const isHtml = (assetResp.headers.get("content-type") || "").includes("text/html");
      if (assetResp.status !== 404) {
        return isHtml ? await applyServerSideBranding(assetResp, env, url) : assetResp;
      }
      const shellResp = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
      return await applyServerSideBranding(shellResp, env, url);
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

// Rewrites <title>, the favicon <link>, and the Open Graph/Twitter meta
// tags directly in the served index.html shell for the requesting
// hostname (and, for /seek links, the requested blood group), using
// HTMLRewriter (native to Workers, no extra dependency).
// The OG tags matter separately from <title>/favicon: link-preview
// crawlers (WhatsApp, Facebook, Telegram, etc) fetch the raw HTML and read
// ONLY og:title/og:description/og:image - they never execute JS, so the
// client-side applyBranding() in app.js (which runs after boot, once JS
// has loaded) has zero effect on what shows up when a link is pasted into
// a chat. This function is the only thing that can fix that, since it
// rewrites the actual bytes sent back for the request.
// This exists ALONGSIDE applyBranding() in app.js rather than replacing
// it - the client-side version still handles branding updates on soft
// (in-app) navigation without a full reload, and stays the source of
// truth for the theme color / logo image in the topbar.
// ALWAYS applies the site-wide settings (site_title, favicon_url,
// welcome_subheading, social_preview_url) regardless of whether multisite
// branding is on, and additionally layers a per-domain override on top
// when multisite branding is on and the hostname matches an entry - a
// brand's og:image falls back to its own logo_url if it has no dedicated
// social_preview_url override (brands don't have their own social-preview
// field; site-wide social_preview_url still wins when set, since it's
// meant to be a purpose-made preview image rather than the logo).
// For /seek?bg=<group> links specifically, title/description are further
// overridden with a live donor count for that group (e.g. "৩জন A+
// রক্তদাতা - IIUC Blood Network"), so sharing a seek link shows the
// current availability right in the chat preview without anyone needing
// to open it first - see seekBrandOverride() below. The og:image tag is
// also dropped entirely for these links, since WhatsApp gives a
// text-only card much more room for the title/description than the
// large-image card it renders whenever an image is present.
// Falls back to leaving the static HTML completely untouched on any
// lookup error - never breaks page load over a branding lookup failure.
async function applyServerSideBranding(shellResp, env, url) {
  try {
    const hostname = url.hostname;
    const settings = await getSettings(env.DB);
    const brand = await getBrandForHostname(env, hostname);
    let title = (brand && brand.site_title) || settings.site_title;
    let description = settings.welcome_subheading;
    const faviconUrl = (brand && brand.favicon_url) || settings.favicon_url;
    const imageUrl = settings.social_preview_url || (brand && brand.logo_url) || settings.logo_url;

    const seekOverride = await seekBrandOverride(env, url, title);
    let suppressImage = false;
    if (seekOverride) {
      title = seekOverride.title;
      description = seekOverride.description;
      // A seek link's whole point is the text (donor count + instructions)
      // - WhatsApp renders a large-image card whenever og:image is
      // present, which squeezes the title/description down to a couple of
      // truncated lines beside the thumbnail. Dropping the image entirely
      // for these links makes WhatsApp fall back to its text-only card
      // instead, giving the count and instructions room to show in full.
      suppressImage = true;
    }

    if (!title && !faviconUrl && !description && !suppressImage && !imageUrl) return shellResp;

    const rewriter = new HTMLRewriter();
    if (title) {
      rewriter.on("title", {
        element(element) { element.setInnerContent(title); },
      });
      rewriter.on("#ogTitle", {
        element(element) { element.setAttribute("content", title); },
      });
    }
    // Point the favicon at a transparent 1x1 pixel instead of removing the
    // tag when suppressing the OG image - with no og:image present, some
    // crawlers (WhatsApp included) fall back to <link rel="icon"> as the
    // preview thumbnail, which defeats the point of dropping og:image for
    // seek links. Swapping the href (rather than calling element.remove())
    // avoids any risk of the tag removal disturbing the rest of the
    // document during the streaming HTMLRewriter pass.
    if (suppressImage) {
      rewriter.on("#faviconLink", {
        element(element) { element.setAttribute("href", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="); },
      });
    } else if (faviconUrl) {
      rewriter.on("#faviconLink", {
        element(element) { element.setAttribute("href", faviconUrl); },
      });
    }
    if (description) {
      rewriter.on('meta[name="description"]', {
        element(element) { element.setAttribute("content", description); },
      });
      rewriter.on("#ogDescription", {
        element(element) { element.setAttribute("content", description); },
      });
    }
    if (suppressImage) {
      // Remove the tag outright rather than leaving content="" - some
      // crawlers treat a present-but-empty og:image as "an image exists,
      // go fetch it", which can still reserve a blank thumbnail slot
      // instead of falling back to the text-only card. The static
      // index.html also declares twitter:card=summary_large_image
      // unconditionally - some crawlers (and WhatsApp's own fallback
      // logic in some cases) consult that tag too and, seeing a
      // large-image card requested with no og:image to match, may go
      // hunting for SOME image on the page (e.g. the first <img> it finds)
      // rather than cleanly falling back to text-only. Downgrading this to
      // a plain "summary" card removes that ambiguity.
      rewriter.on("#ogImage", {
        element(element) { element.remove(); },
      });
      rewriter.on("#twitterCard", {
        element(element) { element.setAttribute("content", "summary"); },
      });
    } else if (imageUrl) {
      // Crawlers generally need an ABSOLUTE image URL, not a relative
      // path - resolve against the current request's origin so an
      // admin-entered "/img/logo.png" style value still works, while a
      // full https:// URL (the common case for uploaded/ImgBB images)
      // passes through unchanged.
      let absoluteImageUrl = imageUrl;
      try { absoluteImageUrl = new URL(imageUrl, `https://${hostname}`).href; } catch { /* leave as-is if unparseable */ }
      rewriter.on("#ogImage", {
        element(element) { element.setAttribute("content", absoluteImageUrl); },
      });
    }
    return rewriter.transform(shellResp);
  } catch {
    return shellResp;
  }
}

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
function toBnDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => BN_DIGITS[+d]);
}

// A literal "+" typed in a URL's query string (e.g. .../seek?bg=A+, exactly
// how someone would naturally write or share it) is NOT the same as an
// encoded "%2B" - an unencoded "+" decodes to a space, so
// URLSearchParams hands back "A " (trailing space), not "A+". Also
// accepts spelled-out word suffixes as an alternative to the symbol -
// positive/pos -> "+", negative/neg -> "-" (case-insensitive), e.g.
// ?bg=Apositive, ?bg=Apos, ?bg=Anegative, ?bg=Aneg. Mirrors the same
// normalization in views-public.js's normalizeBloodGroupParam, since both
// need to tolerate the same hand-typed link.
const BLOOD_GROUP_WORD_SUFFIXES = [["POSITIVE", "+"], ["NEGATIVE", "-"], ["POS", "+"], ["NEG", "-"], ["P", "+"], ["N", "-"]];
function normalizeBloodGroupParam(raw) {
  if (!raw) return null;
  let v = raw.trim();
  if (raw.endsWith(" ") && !v.endsWith("+") && !v.endsWith("-")) v += "+";
  v = v.toUpperCase();
  for (const [word, symbol] of BLOOD_GROUP_WORD_SUFFIXES) {
    if (v.endsWith(word)) { v = v.slice(0, -word.length) + symbol; break; }
  }
  return v;
}

// Formats "now" in Bangladesh local time as e.g. "11:53pm, Sep 23, 2026" -
// matches the style used in the seek-link preview description below.
// Included in that description (not just relied on being fresh at fetch
// time) because WhatsApp and similar link-preview crawlers cache a
// preview per exact URL for a while on their own end - since the donor
// count in the title can go stale behind that cache with no way for this
// app to force a re-fetch, stamping "সর্বশেষ আপডেট" into the visible
// description at least makes a stale cached preview visibly stale rather
// than silently misleading, instead of leaving the person to assume the
// count shown is current.
function formatSeekUpdateTimestamp(date) {
  const timeStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dhaka", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date).replace(/\s?([AP])M$/i, (m, p) => p.toLowerCase() + "m");
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dhaka", month: "short", day: "numeric", year: "numeric",
  }).format(date);
  return `${timeStr}, ${dateStr}`;
}

// For a /seek request carrying a valid ?bg=<group>, returns a
// {title, description} pair showing the CURRENT number of eligible donors
// for that group, e.g. title "৩জন A+ রক্তদাতা - IIUC Blood Network".
// Returns null for any other path, a missing/invalid bg, or on any DB
// error - callers should keep the normal site-wide title/description in
// that case, never block the page over this.
async function seekBrandOverride(env, url, siteTitle) {
  if (url.pathname.replace(/\/+$/, "") !== "/seek") return null;
  const bloodGroup = normalizeBloodGroupParam(url.searchParams.get("bg"));
  if (!isValidBloodGroup(bloodGroup)) return null;
  try {
    const row = await env.DB
      .prepare("SELECT COUNT(*) as c FROM users WHERE is_donor = 1 AND blood_group = ? AND eligibility_status = 'on' AND deleted = 0")
      .bind(bloodGroup)
      .first();
    const count = row ? row.c : 0;
    const titleSuffix = siteTitle ? ` - ${siteTitle}` : "";
    const updatedAt = formatSeekUpdateTimestamp(new Date());
    return {
      title: `${toBnDigits(count)}জন ${bloodGroup} রক্তদাতা${titleSuffix}`,
      description: `(${updatedAt} - সর্বশেষ আপডেট) লিংকে ক্লিক করে এক এক করে কল করে দেখুন কোন ডোনার রক্তদান করতে পারবেন।`,
    };
  } catch {
    return null;
  }
}

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

  if (path === "/api/admin/multisite-branding" && method === "GET") return admin.handleMultisiteGet(request, env);
  if (path === "/api/admin/multisite-branding/toggle" && method === "POST") return admin.handleMultisiteToggle(request, env);
  if (path === "/api/admin/multisite-branding" && method === "POST") return admin.handleMultisiteCreate(request, env);
  if (seg[2] === "multisite-branding" && seg[3] && method === "PUT") return admin.handleMultisiteUpdate(request, env, seg[3]);
  if (seg[2] === "multisite-branding" && seg[3] && method === "DELETE") return admin.handleMultisiteDelete(request, env, seg[3]);

  // Public locations list is also used outside admin (signup forms etc.)
  if (path === "/api/locations" && method === "GET") return admin.handleLocationsList(request, env);
  if (path === "/api/external-sources" && method === "GET") return admin.handleExtSourcesList(request, env);

  return err("Not found", 404);
}
