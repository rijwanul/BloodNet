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

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

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

function bnDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso.replace(" ", "T"));
  const months = ["জানুয়ারি","ফেব্রুয়ারি","মার্চ","এপ্রিল","মে","জুন","জুলাই","আগষ্ট","সেপ্টেম্বর","অক্টোবর","নভেম্বর","ডিসেম্বর"];
  return `${d.getDate()} ${months[d.getMonth()]}, ${d.getFullYear()}`;
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
