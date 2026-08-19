// Small DOM + UI utility layer shared by every view module.

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function icon(name, cls = "") {
  const s = document.createElement("i");
  s.setAttribute("data-lucide", name);
  if (cls) s.className = cls;
  return s;
}

let _iconRefreshQueued = false;
function refreshIcons() {
  // Guard against re-entrancy: lucide.createIcons() itself mutates the DOM
  // (swaps <i data-lucide> placeholders for <svg> elements), and without
  // this guard that mutation is picked up by the MutationObserver below,
  // which calls refreshIcons() again, which mutates the DOM again... an
  // infinite synchronous loop that hangs the tab before anything paints.
  if (_iconRefreshQueued) return;
  _iconRefreshQueued = true;
  requestAnimationFrame(() => {
    _iconRefreshQueued = false;
    if (window.lucide) window.lucide.createIcons();
  });
}

// Icons are async in two ways: (1) the Lucide CDN script itself loads
// after our own JS runs, so early refreshIcons() calls are no-ops, and
// (2) every dynamic re-render (password fields, admin forms, modals, etc)
// creates fresh <i data-lucide> placeholders that need converting. Rather
// than sprinkle refreshIcons() after every single DOM mutation site (easy
// to miss - this is exactly why the password-eye icon was invisible until
// something else happened to trigger a refresh elsewhere), a single
// MutationObserver here catches every insertion automatically, and a
// one-time full sweep runs the moment the Lucide script finishes loading
// so anything rendered before the library was ready still gets its icons
// immediately instead of only on the next incidental refresh. refreshIcons()
// is debounced via requestAnimationFrame above so this observer firing
// repeatedly (including in response to lucide's own output) collapses into
// a single icon pass per frame instead of looping.
(function setupIconAutoRefresh() {
  const observer = new MutationObserver(() => refreshIcons());
  observer.observe(document.body, { childList: true, subtree: true });
  if (window.lucide) {
    refreshIcons(); // script already finished loading before this ran
  } else {
    const script = document.getElementById("lucideScript");
    if (script) script.addEventListener("load", refreshIcons);
  }
})();

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

function pulseDivider(accent) {
  return h("svg", { class: "pulse-divider" + (accent ? " accent" : ""), viewBox: "0 0 300 28", preserveAspectRatio: "none", html:
    '<path d="M0 14 H100 L112 4 L124 24 L136 14 H300" />' });
}

function bloodGroupGrid(selected, onSelect) {
  const groups = ["A+","A-","B+","B-","O+","O-","AB+","AB-"];
  const grid = h("div", { class: "choice-grid" });
  groups.forEach((g) => {
    const btn = h("button", { type: "button", onclick: () => { onSelect(g); [...grid.children].forEach(c => c.classList.remove("selected")); btn.classList.add("selected"); } }, g);
    if (g === selected) btn.classList.add("selected");
    grid.appendChild(btn);
  });
  return grid;
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
function toBnDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => BN_DIGITS[+d]);
}

// Site-wide date format: DD/MM/YYYY (with Bengali digits).
function bnDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso.replace(" ", "T"));
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return toBnDigits(`${dd}/${mm}/${yyyy}`);
}

// Bengali duration formatter for countdowns, e.g.:
//   "১৭ ঘন্টা ২৯ মিনিট ১৩ সেকেন্ড"          (under a day)
//   "২ মাস ১২ দিন ২৩ ঘন্টা"                  (a month or more - no minutes/seconds)
//   "৫ দিন ৩ ঘন্টা"                          (a day or more but under a month)
function bnDuration(fromMs, toMs) {
  let diffMs = Math.max(0, toMs - fromMs);
  const totalMinutes = Math.floor(diffMs / 60000);
  const months = Math.floor(totalMinutes / (30 * 24 * 60));
  let rem = totalMinutes - months * 30 * 24 * 60;
  const days = Math.floor(rem / (24 * 60));
  rem -= days * 24 * 60;
  const hours = Math.floor(rem / 60);
  rem -= hours * 60;
  const minutes = rem;
  const seconds = Math.floor((diffMs % 60000) / 1000);

  if (months > 0) {
    return `${toBnDigits(months)} মাস ${toBnDigits(days)} দিন ${toBnDigits(hours)} ঘন্টা`;
  }
  if (days > 0) {
    return `${toBnDigits(days)} দিন ${toBnDigits(hours)} ঘন্টা`;
  }
  return `${toBnDigits(hours)} ঘন্টা ${toBnDigits(minutes)} মিনিট ${toBnDigits(seconds)} সেকেন্ড`;
}

function setLoading(container) {
  container.innerHTML = "";
  for (let i = 0; i < 3; i++) container.appendChild(h("div", { class: "skeleton", style: "margin-bottom:10px" }));
}

function errorBanner(message) {
  return h("div", { class: "banner banner-error" }, message);
}

// ---------------------------------------------------------------- MODALS
// A minimal, dependency-free modal system used in place of window.confirm/
// alert/prompt so the admin panel (and other flows) feel native rather than
// falling back to browser chrome. Only one modal is shown at a time.
function closeModal() {
  const existing = document.getElementById("modalRoot");
  if (existing) existing.remove();
}

function openModal({ title, body, actions }) {
  closeModal();
  const root = h("div", { id: "modalRoot", class: "modal-root" });
  const box = h("div", { class: "modal-box" });
  box.appendChild(h("div", { class: "modal-header" }, [
    h("h3", {}, title || ""),
    h("button", { class: "modal-close", "aria-label": "বন্ধ করুন", onclick: closeModal }, icon("x")),
  ]));
  const bodyWrap = h("div", { class: "modal-body" });
  if (body) bodyWrap.appendChild(body);
  box.appendChild(bodyWrap);
  if (actions && actions.length) {
    box.appendChild(h("div", { class: "modal-actions" }, actions));
  }
  root.appendChild(box);
  root.addEventListener("click", (e) => { if (e.target === root) closeModal(); });
  document.body.appendChild(root);
  refreshIcons();
  return root;
}

// Promise-based replacement for window.confirm with the app's own styling.
function confirmModal(message, opts = {}) {
  return new Promise((resolve) => {
    const yesBtn = h("button", { class: "btn btn-danger" }, opts.confirmLabel || "নিশ্চিত করুন");
    const noBtn = h("button", { class: "btn btn-outline" }, opts.cancelLabel || "বাতিল");
    openModal({
      title: opts.title || "নিশ্চিত করুন",
      body: h("p", {}, message),
      actions: [noBtn, yesBtn],
    });
    yesBtn.onclick = () => { closeModal(); resolve(true); };
    noBtn.onclick = () => { closeModal(); resolve(false); };
  });
}

// Kept for any lingering synchronous call sites - prefer confirmModal (async) for new code.
function confirmDialog(message) {
  return window.confirm(message);
}

// Simple informational modal (replacement for alert()), optionally showing
// a copyable value (e.g. a freshly generated password).
function infoModal(message, { title, copyValue } = {}) {
  const body = h("div", { class: "stack" }, [h("p", {}, message)]);
  if (copyValue) {
    const box = h("div", { class: "row" }, [
      h("input", { type: "text", readonly: "", value: copyValue, style: "font-family:monospace" }),
      h("button", { class: "btn btn-sm btn-outline", onclick: () => { navigator.clipboard?.writeText(copyValue); toast("কপি করা হয়েছে"); } }, "কপি"),
    ]);
    body.appendChild(box);
  }
  const okBtn = h("button", { class: "btn btn-primary" }, "ঠিক আছে");
  openModal({ title: title || "তথ্য", body, actions: [okBtn] });
  okBtn.onclick = closeModal;
}

// ------------------------------------------------------- PASSWORD FIELD
// A password <input> paired with an eye-icon toggle button. Hidden by
// default. Returns the wrapping element; the actual <input> is accessible
// via wrapper.querySelector('input').
function passwordField(placeholder) {
  const input = h("input", { type: "password", placeholder: placeholder || "পাসওয়ার্ড", autocomplete: "off" });
  const toggleBtn = h("button", { type: "button", class: "eye-toggle", "aria-label": "পাসওয়ার্ড দেখুন/লুকান" }, icon("eye"));
  let visible = false;
  toggleBtn.onclick = () => {
    visible = !visible;
    input.type = visible ? "text" : "password";
    toggleBtn.innerHTML = "";
    toggleBtn.appendChild(icon(visible ? "eye-off" : "eye"));
    refreshIcons();
  };
  const wrap = h("div", { class: "password-field" }, [input, toggleBtn]);
  return wrap;
}

// -------------------------------------------------------- ENTER-TO-SUBMIT
// Pressing Enter inside any of `inputEls` triggers a click on `buttonEl`,
// matching normal form submit behaviour without needing a real <form>.
function enterSubmits(inputEls, buttonEl) {
  const els = [].concat(inputEls);
  els.forEach((el) => {
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!buttonEl.disabled) buttonEl.click();
      }
    });
  });
}

async function locationOptions(selectEl, selectedId) {
  try {
    const { locations } = await API.get("/api/locations");
    const top = locations.filter((l) => !l.parent_id);
    selectEl.innerHTML = '<option value="">নির্বাচন করুন</option>';
    top.forEach((t) => {
      selectEl.appendChild(h("option", { value: t.id, selected: String(t.id) === String(selectedId) ? "" : null }, t.name));
      locations.filter((c) => c.parent_id === t.id).forEach((c) => {
        selectEl.appendChild(h("option", { value: c.id, selected: String(c.id) === String(selectedId) ? "" : null }, "— " + c.name));
      });
    });
  } catch { /* non-fatal */ }
}

// Renders a name/slug as a link to its public profile when a slug exists,
// otherwise as plain text with the given fallback label (e.g. "একজন ডোনার").
function personLink(label, slug) {
  if (slug) return h("a", { href: "/" + slug, "data-link": "" }, label);
  return h("span", {}, label);
}

// today's date as YYYY-MM-DD in the local timezone, for date-input min= attrs
function todayIsoDate() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Picks a stable-per-profile-picture-slot random default avatar from the
// admin-configured list when the person has no uploaded picture, falling
// back to the site logo if none are configured.
function pickDefaultAvatar() {
  const avatars = (APP.settings && APP.settings.defaultAvatars) || [];
  if (!avatars.length) return "/img/logo.png";
  return avatars[Math.floor(Math.random() * avatars.length)];
}
