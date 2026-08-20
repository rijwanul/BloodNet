window.APP = { user: null, settings: null };

const ROUTES = [
  { path: "/", render: (p, v) => ViewsPublic.landing(v) },
  { path: "/seek", render: (p, v) => ViewsPublic.seek(v) },
  { path: "/join", render: (p, v) => ViewsPublic.join(v) },
  { path: "/login", render: (p, v) => ViewsPublic.login(v) },
  { path: "/forgot-password", render: (p, v) => ViewsPublic.forgotPassword(v) },
  { path: "/quick", render: (p, v) => ViewsAccount.quick(v) },
  { path: "/profile", render: (p, v) => ownProfileOrRedirect(v) },
  { path: "/profile/edit", render: (p, v) => ViewsAccount.profileEdit(v) },
  { path: "/profile/privacy", render: (p, v) => ViewsAccount.profilePrivacy(v) },
  { path: "/calls", render: (p, v) => ViewsAccount.calls(v) },
  { path: "/settings", render: (p, v) => ViewsAccount.settings(v) },
  { path: "/admin", render: (p, v) => ViewsAdmin.dashboard(v) },
  { path: "/admin/users", render: (p, v) => ViewsAdmin.users(v) },
  { path: "/admin/external-sources", render: (p, v) => ViewsAdmin.externalSources(v) },
  { path: "/admin/activity-log", render: (p, v) => ViewsAdmin.activityLog(v) },
  { path: "/admin/sms", render: (p, v) => ViewsAdmin.smsSettings(v) },
  { path: "/admin/sms-analytics", render: (p, v) => ViewsAdmin.smsAnalytics(v) },
  { path: "/admin/site-apis", render: (p, v) => ViewsAdmin.siteApis(v) },
  { path: "/admin/site-settings", render: (p, v) => ViewsAdmin.siteSettings(v) },
  { path: "/admin/locations", render: (p, v) => ViewsAdmin.locations(v) },
];

// "/profile" is a stable fallback route (works even before a username
// exists). Once the user has a username/slug, send them to their real,
// bookmarkable profile URL instead.
function ownProfileOrRedirect(v) {
  if (APP.user && APP.user.username) {
    navigate("/" + APP.user.username);
    return;
  }
  return ViewsAccount.profile(v);
}

function navigate(path) {
  if (location.pathname !== path) history.pushState({}, "", path);
  route();
  window.scrollTo(0, 0);
}
window.navigate = navigate;

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", route);

function renderTopbar() {
  const bar = document.getElementById("topbar");
  bar.innerHTML = "";
  const settings = APP.settings || {};
  const logo = h("a", { href: "/", "data-link": "", class: "topbar__logo" }, [
    settings.logoUrl ? h("img", { src: settings.logoUrl, alt: "" }) : icon("droplet"),
    settings.siteTitle || "BloodNet v2",
  ]);
  bar.appendChild(logo);
  bar.appendChild(h("div", { class: "topbar__spacer" }));

  if (APP.user) {
    if (APP.user.isAdmin || APP.user.isRootAdmin) {
      bar.appendChild(h("a", { href: "/admin", "data-link": "", class: "topbar__link", title: "এডমিন প্যানেল" }, icon("shield", "small")));
    }
    // Hidden by default (admin-configurable) - logout is always still
    // reachable from the সেটিংস page even when this is off.
    if (settings.showLogoutButton) {
      bar.appendChild(h("button", { class: "topbar__link", title: "লগআউট", onclick: doLogout, style: "background:none;border:none;cursor:pointer" }, icon("log-out", "small")));
    }
  } else {
    bar.appendChild(h("a", { href: "/login", "data-link": "", class: "topbar__link" }, "লগইন"));
  }
  refreshIcons();
}

// Bottom tab bar: আমার অবস্থা (donors only) / রক্ত দরকার / প্রোফাইল /
// কল হিষ্ট্রি / সেটিংস. Only shown once logged in. On mobile it's fixed to
// the bottom; on desktop it becomes a horizontal bar under the topbar
// (CSS-only difference) so every logged-in feature stays reachable on both.
function renderBottomNav(activePath) {
  let nav = document.getElementById("bottomNav");
  if (!APP.user) {
    if (nav) nav.remove();
    return;
  }
  if (!nav) {
    nav = h("nav", { id: "bottomNav", class: "bottom-nav" });
    document.body.appendChild(nav);
  }
  nav.innerHTML = "";
  const profileHref = APP.user.username ? "/" + APP.user.username : "/profile";
  const items = [];
  if (APP.user.isDonor) items.push(["/quick", "hand-heart", "আমার অবস্থা"]);
  items.push(["/seek", "search", "রক্ত দরকার"]);
  items.push([profileHref, "user", "প্রোফাইল"]);
  items.push(["/calls", "phone-call", "কল হিষ্ট্রি"]);
  items.push(["/settings", "settings", "সেটিংস"]);

  items.forEach(([path, iconName, label]) => {
    const isActive = path === profileHref
      ? (activePath === "/profile" || activePath === profileHref)
      : activePath === path;
    const a = h("a", { href: path, "data-link": "", title: label }, [icon(iconName), h("span", {}, label)]);
    if (isActive) a.classList.add("active");
    nav.appendChild(a);
  });
  refreshIcons();
}

function applyBranding() {
  const s = APP.settings || {};
  if (s.siteTitle) document.title = s.siteTitle;
  if (s.faviconUrl) document.getElementById("faviconLink").setAttribute("href", s.faviconUrl);
  if (s.themeColor) document.documentElement.style.setProperty("--primary", s.themeColor);
}

let _loggingOut = false;
async function doLogout() {
  // Guards against the perceived "sometimes doesn't work" symptom: without
  // this, a slow network made the button look unresponsive with zero
  // feedback, so a person would tap it again (re-entering this function
  // mid-flight) or navigate away assuming it failed. Now the state flips to
  // logged-out optimistically and immediately, and the API call to actually
  // clear the cookie happens in the background - a failure there is non-
  // fatal since the cookie is HttpOnly and short-lived, and logging back in
  // simply issues a fresh one regardless.
  if (_loggingOut) return;
  _loggingOut = true;
  APP.user = null;
  renderTopbar();
  renderBottomNav("/");
  navigate("/");
  try { await API.post("/api/auth/logout"); } catch { /* non-fatal, see above */ }
  _loggingOut = false;
}
window.doLogout = doLogout;

async function route() {
  const view = document.getElementById("view");
  const path = location.pathname.replace(/\/+$/, "") || "/";

  // Gate donor-only / admin-only routes.
  if (["/quick", "/profile", "/profile/edit", "/profile/privacy", "/calls", "/settings"].includes(path) && !APP.user) {
    return navigate("/login");
  }
  if (path.startsWith("/admin") && !(APP.user && (APP.user.isAdmin || APP.user.isRootAdmin))) {
    return navigate("/");
  }

  renderBottomNav(path);

  const match = ROUTES.find((r) => r.path === path);
  if (match) {
    view.innerHTML = "";
    setLoading(view);
    try {
      await match.render(path, view);
    } catch (e) {
      view.innerHTML = "";
      view.appendChild(errorBanner(e.message || "একটি সমস্যা হয়েছে"));
    }
    refreshIcons();
    return;
  }

  // Not a known app route -> treat single-segment path as a username.
  // If it matches the logged-in user's own username, show the full
  // owner/editable profile instead of the read-only public view.
  const seg = path.split("/").filter(Boolean);
  if (seg.length === 1) {
    view.innerHTML = "";
    setLoading(view);
    try {
      if (APP.user && APP.user.username && seg[0].toLowerCase() === APP.user.username.toLowerCase()) {
        await ViewsAccount.profile(view);
      } else {
        await ViewsPublic.publicProfile(view, seg[0]);
      }
    } catch (e) {
      view.innerHTML = "";
      view.appendChild(errorBanner("প্রোফাইল পাওয়া যায়নি"));
    }
    refreshIcons();
    return;
  }
  view.innerHTML = "";
  view.appendChild(errorBanner("পেইজটি পাওয়া যায়নি"));
}

async function boot() {
  try {
    const [settingsRes, meRes] = await Promise.all([
      API.get("/api/settings/public").catch(() => ({})),
      API.get("/api/auth/me").catch(() => ({ user: null })),
    ]);
    APP.settings = settingsRes;
    APP.user = meRes.user || null;
  } catch { /* proceed with defaults */ }
  applyBranding();
  renderTopbar();

  if (APP.user && APP.user.mustChangePassword && location.pathname !== "/settings") {
    toast("প্রথমবার লগইনে পাসওয়ার্ড পরিবর্তন করুন");
    return navigate("/settings");
  }
  await route();
}

boot();
