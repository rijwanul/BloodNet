const ViewsAdmin = {};

const ADMIN_NAV_ITEMS = [
  ["/admin", "layout-dashboard", "এনালিটিক্স"],
  ["/admin/users", "users", "ইউজার লিষ্ট"],
  ["/admin/external-sources", "external-link", "এক্সটার্নাল সোর্সেস"],
  ["/admin/activity-log", "history", "এক্টিভিটি লগ"],
  ["/admin/sms", "message-square", "এসএমএস সেটিংস"],
  ["/admin/sms-analytics", "bar-chart-3", "এসএমএস এনালিটিক্স"],
  ["/admin/site-apis", "key", "সাইট এপিআই"],
  ["/admin/site-settings", "settings-2", "সাইট সেটিংস"],
  ["/admin/multisite-branding", "globe", "মাল্টিসাইট ব্র্যান্ডিং"],
  ["/admin/locations", "map-pin", "লোকেশন"],
  ["/admin/help", "help-circle", "সহায়িকা"],
];

function adminNav(active) {
  const nav = h("div", { class: "admin-nav" });
  ADMIN_NAV_ITEMS.forEach(([path, iconName, label]) => {
    const a = h("a", { href: path, "data-link": "" }, [icon(iconName, "small"), h("span", {}, label)]);
    if (path === active) a.classList.add("active");
    nav.appendChild(a);
  });
  return nav;
}

// Every admin page shares this shell: a heading, the nav (sidebar on
// desktop via .admin-layout/.admin-content flex, a horizontal scroller on
// mobile), and a content area callers append their page-specific UI into.
// Wires a checkbox to save immediately on change, via whichever settings
// endpoint the caller specifies - toggle switches across the admin panel
// no longer require a separate "সংরক্ষণ করুন" click, per spec. Reverts the
// checkbox and shows the error if the save fails, so the UI never shows a
// state that wasn't actually persisted.
function wireInstantToggle(checkbox, putFn, key) {
  checkbox.onchange = async () => {
    const newValue = checkbox.checked;
    checkbox.disabled = true;
    try {
      await putFn({ [key]: newValue });
    } catch (e) {
      checkbox.checked = !newValue;
      toast(e.message);
    } finally {
      checkbox.disabled = false;
    }
  };
}

function adminPage(view, title, activePath) {
  view.innerHTML = "";
  view.appendChild(h("h2", {}, title));
  const layout = h("div", { class: "admin-layout" });
  layout.appendChild(adminNav(activePath));
  const content = h("div", { class: "admin-content" });
  layout.appendChild(content);
  view.appendChild(layout);
  return content;
}

// Bengali labels for calls.status, matching the labels shown to donors on
// the call-status buttons in views-public.js (renderCallStatusButtons) -
// kept in sync manually since there's no shared constants module between
// the public and admin JS bundles. 'pending' is the only status never
// chosen by a donor (see schema.sql's comment on calls.status) - it just
// means no outcome has been reported yet for that call.
const CALL_STATUS_LABELS = {
  pending: "অপেক্ষমাণ (কোনো ষ্ট্যাটাস দেওয়া হয়নি)",
  no_answer: "কল যাচ্ছে না",
  not_picked_up: "কল ধরেনি",
  cannot_donate: "রক্ত দিতে পারবে না",
  can_donate: "রক্ত দিতে পারবে",
  not_called: "কল করিনি",
};

// Small self-contained horizontal bar chart, built as inline SVG - the app
// has no charting library, and this dataset (a handful of call-status
// counts) doesn't warrant adding one.
function horizontalBarChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const rowH = 30, gap = 8, labelW = 180, chartW = 320, width = labelW + chartW + 50;
  const height = rows.length * (rowH + gap);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("style", `max-width:${width}px`);
  rows.forEach((r, i) => {
    const y = i * (rowH + gap);
    const barW = (r.value / max) * chartW;
    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", labelW - 8);
    label.setAttribute("y", y + rowH / 2 + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "12");
    label.setAttribute("fill", "var(--ink-soft)");
    label.textContent = r.label;
    svg.appendChild(label);
    const bar = document.createElementNS(svg.namespaceURI, "rect");
    bar.setAttribute("x", labelW);
    bar.setAttribute("y", y);
    bar.setAttribute("width", String(Math.max(2, barW)));
    bar.setAttribute("height", String(rowH));
    bar.setAttribute("rx", "5");
    bar.setAttribute("fill", "var(--primary)");
    svg.appendChild(bar);
    const val = document.createElementNS(svg.namespaceURI, "text");
    val.setAttribute("x", labelW + barW + 8);
    val.setAttribute("y", y + rowH / 2 + 4);
    val.setAttribute("font-size", "12");
    val.setAttribute("font-weight", "700");
    val.setAttribute("fill", "var(--ink)");
    val.textContent = String(r.value);
    svg.appendChild(val);
  });
  return svg;
}

// -------------------------------------------------------------- DASHBOARD
ViewsAdmin.dashboard = async function (view) {
  const content = adminPage(view, "এডমিন প্যানেল", "/admin");
  const stats = await API.get("/api/admin/analytics");

  // Only these three surface up top per spec - everything else lives
  // behind the "See more" section below.
  const grid = h("div", { class: "stat-grid" });
  const primaryCards = [
    ["মোট ইউজার", stats.totalUsers],
    ["এভেইলেবল ডোনার", stats.totalAvailable],
    ["রক্ত ম্যানেজ হয়েছে", stats.totalManaged],
  ];
  primaryCards.forEach(([label, num]) => grid.appendChild(h("div", { class: "stat-card" }, [h("div", { class: "num" }, String(num)), h("div", { class: "label" }, label)])));
  content.appendChild(grid);

  const moreDetails = h("details", { class: "card stat-see-more-card" });
  moreDetails.appendChild(h("summary", { class: "stat-see-more-toggle" }, " আরো দেখুন"));
  const moreGrid = h("div", { class: "stat-grid", style: "margin-top:14px" });
  const secondaryCards = [
    ["কলের ষ্ট্যাটাস আপডেট করা হয়েছে", stats.totalStatusUpdated],
    ["মোট সিকার", stats.totalSeekers],
    ["মোট ডোনার", stats.totalDonors],
    ["ষ্ট্যাটাস বন্ধ, সর্বশেষ রক্তদানের তারিখ দেয়া নেই", stats.totalOffNoDonation],
    ["সময় হয়েছে, কিন্তু ষ্ট্যাটাস বন্ধ", stats.totalOffPastWait],
    ["রক্ত দেওয়ার সময় হয়নি", stats.totalWaitingAfterDonation],
    ["সাময়িক স্থগিত", stats.totalSnoozed],
    ["মোট কল করা হয়েছে", stats.totalCallsMade],
  ];
  secondaryCards.forEach(([label, num]) => moreGrid.appendChild(h("div", { class: "stat-card" }, [h("div", { class: "num" }, String(num)), h("div", { class: "label" }, label)])));
  moreDetails.appendChild(moreGrid);
  content.appendChild(moreDetails);

  const groupCard = h("div", { class: "card" });
  groupCard.appendChild(h("h3", {}, "রক্তের গ্রুপ অনুযায়ী"));
  const table = h("table");
  table.appendChild(h("tr", {}, [h("th", {}, "গ্রুপ"), h("th", {}, "মোট"), h("th", {}, "এভেইলেবল")]));
  (stats.byGroup || []).forEach((g) => table.appendChild(h("tr", {}, [h("td", {}, g.blood_group), h("td", {}, String(g.total)), h("td", {}, String(g.eligible || 0))])));
  groupCard.appendChild(h("div", { class: "table-wrap" }, table));
  content.appendChild(groupCard);

  const callStatusCard = h("div", { class: "card" });
  callStatusCard.appendChild(h("h3", {}, "কল স্ট্যাটাস অনুযায়ী"));
  const statusRows = (stats.byCallStatus || [])
    .map((r) => ({ key: r.status, label: CALL_STATUS_LABELS[r.status] || r.status, value: r.total }))
    .sort((a, b) => b.value - a.value);
  if (statusRows.length) {
    callStatusCard.appendChild(h("div", { style: "overflow-x:auto" }, horizontalBarChart(statusRows)));
    const statusTable = h("table");
    statusTable.appendChild(h("tr", {}, [h("th", {}, "স্ট্যাটাস"), h("th", {}, "সংখ্যা")]));
    statusRows.forEach((r) => statusTable.appendChild(h("tr", {}, [h("td", {}, r.label), h("td", {}, String(r.value))])));
    callStatusCard.appendChild(h("div", { class: "table-wrap", style: "margin-top:14px" }, statusTable));
  } else {
    callStatusCard.appendChild(h("p", { class: "muted" }, "এখনো কোনো কল হয়নি।"));
  }
  content.appendChild(callStatusCard);
};

// ------------------------------------------------------------------ USERS
ViewsAdmin.users = async function (view) {
  const content = adminPage(view, "ইউজার লিষ্ট", "/admin/users");

  const toolbar = h("div", { class: "row", style: "margin-bottom:12px;flex-wrap:wrap" });
  const searchField = h("input", { type: "text", placeholder: "মোবাইল/নাম দিয়ে খুঁজুন", style: "flex:1;min-width:160px" });
  const searchBtn = h("button", { class: "btn btn-sm btn-outline" }, [icon("search", "small"), " খুঁজুন"]);
  const addBtn = h("button", { class: "btn btn-sm btn-primary" }, [icon("user-plus", "small"), " নতুন ইউজার"]);
  const importBtn = h("button", { class: "btn btn-sm btn-outline" }, [icon("upload", "small"), " CSV ইম্পোর্ট"]);
  const exportBtn = h("button", { class: "btn btn-sm btn-outline" }, [icon("download", "small"), " CSV এক্সপোর্ট"]);
  toolbar.appendChild(searchField); toolbar.appendChild(searchBtn); toolbar.appendChild(addBtn); toolbar.appendChild(importBtn); toolbar.appendChild(exportBtn);
  content.appendChild(toolbar);
  enterSubmits(searchField, searchBtn);

  const formArea = h("div");
  content.appendChild(formArea);
  const listArea = h("div");
  content.appendChild(listArea);

  addBtn.onclick = () => renderUserCreateForm(formArea, () => loadUsers());
  importBtn.onclick = () => renderUserImportForm(formArea, () => loadUsers());
  exportBtn.onclick = () => { window.open("/api/admin/users/export", "_blank"); };
  searchBtn.onclick = () => loadUsers();

  async function loadUsers() {
    formArea.innerHTML = "";
    listArea.innerHTML = "";
    setLoading(listArea);
    const q = encodeURIComponent(searchField.value.trim());
    const { users } = await API.get(`/api/admin/users?q=${q}`);
    listArea.innerHTML = "";
    if (!users.length) { listArea.appendChild(h("p", { class: "muted" }, "কোনো ইউজার পাওয়া যায়নি")); return; }

    const bulkBar = h("div", { class: "row", style: "margin-bottom:10px" });
    const selectAll = h("input", { type: "checkbox" });
    const bulkSelect = h("select");
    [["disable", "নিষ্ক্রিয় করুন"], ["enable", "সক্রিয় করুন"], ["reset_password", "পাসওয়ার্ড রিসেট"], ["sms_limit", "এসএমএস লিমিট পরিবর্তন"], ["delete", "ডিলিট"]]
      .forEach(([v, l]) => bulkSelect.appendChild(h("option", { value: v }, l)));
    const bulkBtn = h("button", { class: "btn btn-sm btn-outline" }, "প্রয়োগ করুন");
    bulkBar.appendChild(selectAll); bulkBar.appendChild(bulkSelect); bulkBar.appendChild(bulkBtn);
    listArea.appendChild(bulkBar);

    const table = h("table");
    table.appendChild(h("tr", {}, ["", "মোবাইল", "নাম", "রোল", "ডোনার", "স্ট্যাটাস", ""].map((t) => h("th", {}, t))));
    const checks = [];
    users.forEach((u) => {
      const cb = h("input", { type: "checkbox" });
      checks.push([cb, u.id]);
      const roleLabel = u.is_root_admin ? "রুট এডমিন" : u.is_admin ? "এডমিন" : "সাধারণ";
      const editBtn = h("button", { class: "btn btn-sm btn-outline", onclick: () => renderUserEditForm(formArea, u, loadUsers) }, [icon("pencil", "small"), " এডিট"]);
      const mobileCell = u.username_display
        ? h("a", { href: "/" + u.username_display, "data-link": "" }, u.mobile)
        : u.mobile;
      table.appendChild(h("tr", {}, [
        h("td", {}, cb), h("td", {}, mobileCell), h("td", {}, u.name || "-"), h("td", {}, roleLabel),
        h("td", {}, u.is_donor ? "হ্যাঁ" : "না"), h("td", {}, u.disabled ? "নিষ্ক্রিয়" : "সক্রিয়"), h("td", {}, editBtn),
      ]));
    });
    listArea.appendChild(h("div", { class: "table-wrap" }, table));
    refreshIcons();
    selectAll.onchange = () => checks.forEach(([cb]) => (cb.checked = selectAll.checked));
    bulkBtn.onclick = async () => {
      const ids = checks.filter(([cb]) => cb.checked).map(([, id]) => id);
      if (!ids.length) return toast("ইউজার নির্বাচন করুন");
      if (bulkSelect.value === "reset_password") {
        return renderBulkResetPasswordModal(ids, loadUsers);
      }
      if (bulkSelect.value === "sms_limit") {
        return renderSmsLimitOverrideModal(ids, loadUsers);
      }
      const label = bulkSelect.options[bulkSelect.selectedIndex].textContent;
      const sure = await confirmModal(`${ids.length} জন ইউজারে "${label}" প্রয়োগ করবেন?`, { title: "নিশ্চিত করুন" });
      if (!sure) return;
      try { await API.post("/api/admin/users/bulk", { ids, action: bulkSelect.value }); toast("সম্পন্ন হয়েছে"); loadUsers(); }
      catch (e) { toast(e.message); }
    };
  }
  loadUsers();
};

// Admin-initiated password reset: admin can either type a password manually
// or leave it blank to auto-generate one. Either way the affected account
// holder(s) get notified by SMS, and if a password was auto-generated the
// admin sees it here (since they'd otherwise have no way to know it).
function renderBulkResetPasswordModal(ids, onDone) {
  const pwWrap = passwordField("খালি রাখলে স্বয়ংক্রিয় পাসওয়ার্ড তৈরি হবে");
  const pwField = pwWrap.querySelector("input");
  const body = h("div", { class: "stack" }, [
    h("p", { class: "small muted" }, `${ids.length} জন ইউজারের পাসওয়ার্ড রিসেট হবে। একাউন্ট হোল্ডারদের এসএমএস দিয়ে জানানো হবে।`),
    h("div", { class: "field" }, [h("label", {}, "নতুন পাসওয়ার্ড (ঐচ্ছিক)"), pwWrap]),
  ]);
  const confirmBtn = h("button", { class: "btn btn-primary" }, "রিসেট করুন");
  const cancelBtn = h("button", { class: "btn btn-outline" }, "বাতিল");
  openModal({ title: "পাসওয়ার্ড রিসেট", body, actions: [cancelBtn, confirmBtn] });
  cancelBtn.onclick = closeModal;
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    try {
      const res = await API.post("/api/admin/users/bulk", { ids, action: "reset_password", newPassword: pwField.value.trim() || undefined });
      closeModal();
      if (res.generatedPassword) {
        infoModal(`নতুন পাসওয়ার্ড স্বয়ংক্রিয়ভাবে তৈরি হয়েছে:`, { title: "পাসওয়ার্ড রিসেট হয়েছে", copyValue: res.generatedPassword });
      } else {
        toast("পাসওয়ার্ড রিসেট হয়েছে");
      }
      onDone();
    } catch (e) { toast(e.message); confirmBtn.disabled = false; }
  };
}

// Bulk (or single-user, called with a one-element array) SMS daily limit
// override - leaving a field blank means "don't change that one", so an
// admin can bump just the user-initiated limit without touching the
// system limit, or vice versa, in one shot for many users at once without
// a full site settings save.
function renderSmsLimitOverrideModal(ids, onDone) {
  const userField = h("input", { type: "number", min: "0", placeholder: "অপরিবর্তিত রাখতে খালি রাখুন" });
  const systemField = h("input", { type: "number", min: "0", placeholder: "অপরিবর্তিত রাখতে খালি রাখুন" });
  const body = h("div", { class: "stack" }, [
    h("p", { class: "small muted" }, `${ids.length} জন ইউজারের জন্য প্রযোজ্য হবে। সাইট-ওয়াইড ডিফল্ট সেটিংস পরিবর্তন হবে না।`),
    h("div", { class: "field" }, [h("label", {}, "ইউজার-উদ্যোগী এসএমএস দৈনিক লিমিট"), userField]),
    h("div", { class: "field" }, [h("label", {}, "সিস্টেম এসএমএস দৈনিক লিমিট"), systemField]),
  ]);
  const confirmBtn = h("button", { class: "btn btn-primary" }, "প্রয়োগ করুন");
  const cancelBtn = h("button", { class: "btn btn-outline" }, "বাতিল");
  openModal({ title: "এসএমএস লিমিট পরিবর্তন", body, actions: [cancelBtn, confirmBtn] });
  cancelBtn.onclick = closeModal;
  confirmBtn.onclick = async () => {
    const payload = { ids };
    if (userField.value !== "") payload.userInitiatedLimit = parseInt(userField.value, 10);
    if (systemField.value !== "") payload.systemLimit = parseInt(systemField.value, 10);
    if (payload.userInitiatedLimit === undefined && payload.systemLimit === undefined) return toast("অন্তত একটি ফিল্ড পূরণ করুন");
    confirmBtn.disabled = true;
    try {
      await API.post("/api/admin/sms-limit-override", payload);
      toast("সংরক্ষণ করা হয়েছে");
      closeModal();
      onDone();
    } catch (e) { toast(e.message); confirmBtn.disabled = false; }
  };
}

function renderUserCreateForm(area, onDone) {
  area.innerHTML = "";
  const card = h("div", { class: "card stack" });
  card.appendChild(h("h3", {}, "নতুন ইউজার"));
  const mobile = h("input", { type: "tel", placeholder: "মোবাইল নাম্বার" });
  const name = h("input", { type: "text", placeholder: "নাম (ঐচ্ছিক)" });
  const pwWrap = passwordField("পাসওয়ার্ড (খালি রাখলে অটো তৈরি হবে)");
  const password = pwWrap.querySelector("input");
  password.type = "text"; // admin is creating this on someone's behalf; show plainly by default
  pwWrap.querySelector(".eye-toggle").click(); // sync icon state with the text-by-default choice above
  const changeReq = h("input", { type: "checkbox" });
  card.appendChild(h("div", { class: "field" }, mobile));
  card.appendChild(h("div", { class: "field" }, name));
  card.appendChild(h("div", { class: "field" }, pwWrap));
  card.appendChild(h("div", { class: "checkbox-row" }, [changeReq, h("span", { class: "lbl" }, "প্রথম লগইনে পাসওয়ার্ড পরিবর্তন বাধ্যতামূলক")]));
  const saveBtn = h("button", { class: "btn btn-primary" }, "তৈরি করুন");
  card.appendChild(saveBtn);
  area.appendChild(card);
  enterSubmits([mobile, name, password], saveBtn);
  saveBtn.onclick = async () => {
    try {
      const res = await API.post("/api/admin/users", { mobile: mobile.value.trim(), name: name.value, password: password.value || undefined, requireChangeOnLogin: changeReq.checked });
      area.innerHTML = "";
      if (res.generatedPassword) {
        infoModal("নতুন ইউজারের জন্য স্বয়ংক্রিয়ভাবে পাসওয়ার্ড তৈরি হয়েছে:", { title: "ইউজার তৈরি হয়েছে", copyValue: res.generatedPassword });
      } else {
        toast("ইউজার তৈরি হয়েছে");
      }
      onDone();
    } catch (e) { toast(e.message); }
  };
}

async function renderUserImportForm(area, onDone) {
  area.innerHTML = "";
  const card = h("div", { class: "card stack" });
  card.appendChild(h("h3", {}, "CSV ইম্পোর্ট"));
  card.appendChild(h("p", { class: "small muted" }, "কলাম: mobile, name, password, bloodGroup, isDonor"));
  const textarea = h("textarea", { placeholder: "mobile,name,password,bloodGroup,isDonor" });
  const changeReq = h("input", { type: "checkbox" });
  card.appendChild(h("div", { class: "field" }, textarea));
  card.appendChild(h("div", { class: "checkbox-row" }, [changeReq, h("span", { class: "lbl" }, "প্রথম লগইনে পাসওয়ার্ড পরিবর্তন বাধ্যতামূলক (ডিফল্ট বন্ধ)")]));
  const btn = h("button", { class: "btn btn-primary" }, "ইম্পোর্ট করুন");
  card.appendChild(btn);
  area.appendChild(card);
  btn.onclick = async () => {
    try {
      const res = await API.post("/api/admin/users/import", { csv: textarea.value, requireChangeOnLogin: changeReq.checked });
      area.innerHTML = "";
      if (res.errors.length) {
        infoModal(`${res.created} জন তৈরি হয়েছে।\n\nত্রুটি:\n${res.errors.join("\n")}`, { title: "ইম্পোর্ট সম্পন্ন" });
      } else {
        toast(`${res.created} জন তৈরি হয়েছে`);
      }
      onDone();
    } catch (e) { toast(e.message); }
  };
}

async function renderUserEditForm(area, u, onDone) {
  const body = h("div", { class: "stack" });

  const mobileField = h("input", { type: "text" }); mobileField.value = u.mobile;
  body.appendChild(h("div", { class: "field" }, [h("label", {}, "মোবাইল"), mobileField]));

  const usernameField = h("input", { type: "text" }); usernameField.value = u.username_display || "";
  body.appendChild(h("div", { class: "field" }, [h("label", {}, "ইউজারনেইম"), usernameField]));

  const name = h("input", { type: "text" }); name.value = u.name || "";
  body.appendChild(h("div", { class: "field" }, [h("label", {}, "নাম"), name]));

  const isDonorCb = h("input", { type: "checkbox" }); isDonorCb.checked = !!u.is_donor;
  body.appendChild(h("div", { class: "checkbox-row" }, [isDonorCb, h("span", { class: "lbl" }, "ডোনার")]));

  let bloodGroup = u.blood_group;
  const bgWrap = h("div", { style: "display:" + (u.is_donor ? "block" : "none") });
  bgWrap.appendChild(h("div", { class: "field" }, [h("label", {}, "রক্তের গ্রুপ"), bloodGroupGrid(bloodGroup, (g) => (bloodGroup = g))]));
  const eligSelect = h("select");
  [["on", "চালু"], ["snoozed", "স্থগিত"], ["off", "বন্ধ"]].forEach(([v, l]) => eligSelect.appendChild(h("option", { value: v, selected: u.eligibility_status === v ? "" : null }, l)));
  bgWrap.appendChild(h("div", { class: "field" }, [h("label", {}, "এলিজিবিলিটি (এভেইলেবিলিটি)"), eligSelect]));
  body.appendChild(bgWrap);
  isDonorCb.onchange = () => (bgWrap.style.display = isDonorCb.checked ? "block" : "none");

  const isAdmin = h("input", { type: "checkbox" }); isAdmin.checked = !!u.is_admin; isAdmin.disabled = !!u.is_root_admin;
  body.appendChild(h("div", { class: "checkbox-row" }, [isAdmin, h("span", { class: "lbl" }, "এডমিন")]));

  const permsWrap = h("div", { style: "display:" + (u.is_admin ? "block" : "none") });
  const { permissions } = await API.get("/api/admin/permissions");
  const permChecks = permissions.map((p) => {
    const cb = h("input", { type: "checkbox", value: p.key });
    permsWrap.appendChild(h("div", { class: "checkbox-row" }, [cb, h("span", { class: "lbl" }, p.label)]));
    return [cb, p.key];
  });
  body.appendChild(permsWrap);
  isAdmin.onchange = () => (permsWrap.style.display = isAdmin.checked ? "block" : "none");

  const resetBtn = h("button", { class: "btn btn-outline btn-sm" }, [icon("key-round", "small"), " পাসওয়ার্ড রিসেট"]);
  const disableBtn = h("button", { class: "btn btn-outline btn-sm" }, u.disabled ? "সক্রিয় করুন" : "নিষ্ক্রিয় করুন");
  const deleteBtn = h("button", { class: "btn btn-outline btn-sm", style: "color:var(--primary)" }, "ডিলিট");
  body.appendChild(h("div", { class: "row", style: "flex-wrap:wrap;margin-top:6px" }, [resetBtn, disableBtn, deleteBtn]));

  const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ করুন");
  const cancelBtn = h("button", { class: "btn btn-outline" }, "বাতিল");
  openModal({ title: `এডিট: ${u.mobile}`, body, actions: [cancelBtn, saveBtn] });
  cancelBtn.onclick = closeModal;
  refreshIcons();

  saveBtn.onclick = async () => {
    const perms = permChecks.filter(([cb]) => cb.checked).map(([, key]) => key);
    const payload = {
      name: name.value, isAdmin: isAdmin.checked, permissions: perms,
      isDonor: isDonorCb.checked, mobile: mobileField.value.trim(), username: usernameField.value.trim(),
    };
    if (isDonorCb.checked) { payload.bloodGroup = bloodGroup; payload.eligibilityStatus = eligSelect.value; }
    try {
      await API.put(`/api/admin/users/${u.id}`, payload);
      toast("আপডেট হয়েছে"); closeModal(); onDone();
    } catch (e) { toast(e.message); }
  };
  resetBtn.onclick = () => { closeModal(); renderBulkResetPasswordModal([u.id], onDone); };
  disableBtn.onclick = async () => {
    try { await API.post("/api/admin/users/bulk", { ids: [u.id], action: u.disabled ? "enable" : "disable" }); toast("আপডেট হয়েছে"); closeModal(); onDone(); }
    catch (e) { toast(e.message); }
  };
  deleteBtn.onclick = async () => {
    const sure = await confirmModal("নিশ্চিতভাবে ডিলিট করবেন?", { title: "ইউজার ডিলিট" });
    if (!sure) return;
    try { await API.del(`/api/admin/users/${u.id}`); toast("ডিলিট হয়েছে"); closeModal(); onDone(); }
    catch (e) { toast(e.message); }
  };
}

// ---------------------------------------------------------- EXTERNAL SOURCES
ViewsAdmin.externalSources = async function (view) {
  const content = adminPage(view, "এক্সটার্নাল সোর্সেস", "/admin/external-sources");
  const listArea = h("div");
  content.appendChild(listArea);

  async function load() {
    listArea.innerHTML = "";
    const { sources } = await API.get("/api/admin/external-sources");
    sources.forEach((s) => {
      const nameF = h("input", { type: "text" }); nameF.value = s.name;
      const urlF = h("input", { type: "text" }); urlF.value = s.url;
      const row = h("div", { class: "card stack" }, [
        h("div", { class: "field" }, [h("label", {}, "নাম"), nameF]),
        h("div", { class: "field" }, [h("label", {}, "URL"), urlF]),
        h("div", { class: "btn-row" }, [
          h("button", { class: "btn btn-sm btn-outline", onclick: async () => { await API.put(`/api/admin/external-sources/${s.id}`, { name: nameF.value, url: urlF.value, sortOrder: s.sort_order }); toast("আপডেট হয়েছে"); } }, "সংরক্ষণ"),
          h("button", { class: "btn btn-sm btn-danger", onclick: async () => { const sure = await confirmModal("ডিলিট করবেন?"); if (sure) { await API.del(`/api/admin/external-sources/${s.id}`); load(); } } }, "ডিলিট"),
        ]),
      ]);
      listArea.appendChild(row);
    });
  }
  await load();

  const addCard = h("div", { class: "card stack" });
  addCard.appendChild(h("h3", {}, "নতুন সোর্স"));
  const newName = h("input", { type: "text", placeholder: "নাম" });
  const newUrl = h("input", { type: "text", placeholder: "URL" });
  addCard.appendChild(h("div", { class: "field" }, newName));
  addCard.appendChild(h("div", { class: "field" }, newUrl));
  const addBtn = h("button", { class: "btn btn-primary" }, "যোগ করুন");
  addCard.appendChild(addBtn);
  enterSubmits([newName, newUrl], addBtn);
  addBtn.onclick = async () => {
    try { await API.post("/api/admin/external-sources", { name: newName.value, url: newUrl.value }); toast("যোগ হয়েছে"); newName.value = ""; newUrl.value = ""; load(); }
    catch (e) { toast(e.message); }
  };
  content.appendChild(addCard);
};

// -------------------------------------------------------------- ACTIVITY LOG
ViewsAdmin.activityLog = async function (view) {
  const content = adminPage(view, "এক্টিভিটি লগ", "/admin/activity-log");

  const toolbar = h("div", { class: "row", style: "flex-wrap:wrap;margin-bottom:12px;gap:8px" });
  const whoField = h("input", { type: "text", placeholder: "কে (নাম/মোবাইল)", style: "flex:1;min-width:140px" });
  const catSelect = h("select");
  [["", "সব ক্যাটাগরি"], ["account", "Account"], ["settings", "Settings"], ["call", "Call"], ["donation", "Donation"], ["admin", "Admin"], ["system", "System"]]
    .forEach(([v, l]) => catSelect.appendChild(h("option", { value: v }, l)));
  const dateFromField = h("input", { type: "date", title: "শুরুর তারিখ" });
  const dateToField = h("input", { type: "date", title: "শেষ তারিখ" });
  const filterBtn = h("button", { class: "btn btn-sm btn-outline" }, "ফিল্টার");
  const refreshBtn = h("button", { class: "btn btn-sm btn-primary" }, [icon("refresh-cw", "small")]);
  const purgeBtn = h("button", { class: "btn btn-sm btn-outline", style: "color:var(--primary)" }, "পার্জ");
  [whoField, catSelect, dateFromField, dateToField, filterBtn, refreshBtn, purgeBtn].forEach((el) => toolbar.appendChild(el));
  content.appendChild(toolbar);
  enterSubmits(whoField, filterBtn);

  const listArea = h("div");
  content.appendChild(listArea);
  const pagerArea = h("div", { class: "row", style: "justify-content:center;gap:10px;margin-top:12px" });
  content.appendChild(pagerArea);

  let currentPage = 1;

  async function load(page = 1) {
    currentPage = page;
    listArea.innerHTML = "";
    setLoading(listArea);
    const params = { who: whoField.value.trim(), category: catSelect.value, page: String(page) };
    if (dateFromField.value) params.dateFrom = dateFromField.value;
    if (dateToField.value) params.dateTo = dateToField.value;
    const q = new URLSearchParams(params).toString();
    const { entries, totalPages, total } = await API.get(`/api/admin/activity-log?${q}`);
    listArea.innerHTML = "";
    if (!entries.length) { listArea.appendChild(h("p", { class: "muted" }, "কোনো লগ পাওয়া যায়নি")); pagerArea.innerHTML = ""; return; }

    // Proper table: aligned columns, a header row, and no leaked
    // "[category]" prefix in the text - category is its own column instead.
    const table = h("table", { class: "activity-log-table" });
    table.appendChild(h("thead", {}, h("tr", {}, [
      h("th", {}, "সময়"), h("th", {}, "কে"), h("th", {}, "ক্যাটাগরি"), h("th", {}, "বিবরণ"),
    ])));
    const tbody = h("tbody");
    entries.forEach((e) => {
      tbody.appendChild(h("tr", {}, [
        h("td", { class: "small muted" }, bnDateTime(e.created_at)),
        h("td", {}, e.actor_label || "সিস্টেম"),
        h("td", {}, h("span", { class: "badge badge-bg" }, e.category)),
        h("td", {}, e.action_text),
      ]));
    });
    table.appendChild(tbody);
    listArea.appendChild(table);

    pagerArea.innerHTML = "";
    if (totalPages > 1) {
      const prevBtn = h("button", { class: "btn btn-sm btn-outline", disabled: page <= 1 }, "আগের");
      const pageLabel = h("span", { class: "small muted" }, `${toBnDigits(page)} / ${toBnDigits(totalPages)} (মোট ${toBnDigits(total)})`);
      const nextBtn = h("button", { class: "btn btn-sm btn-outline", disabled: page >= totalPages }, "পরের");
      prevBtn.onclick = () => load(page - 1);
      nextBtn.onclick = () => load(page + 1);
      pagerArea.appendChild(prevBtn); pagerArea.appendChild(pageLabel); pagerArea.appendChild(nextBtn);
    }
  }

  filterBtn.onclick = () => load(1);
  refreshBtn.onclick = () => load(currentPage);
  purgeBtn.onclick = () => openPurgeModal(load, currentPage);
  await load(1);
};

function openPurgeModal(reload, currentPage) {
  const body = h("div", { class: "stack" });
  const allBtn = h("button", { class: "btn btn-outline", style: "color:var(--primary)" }, "সম্পূর্ণ লগ ডিলিট করুন");
  const orField = h("input", { type: "number", min: "1", placeholder: "যেমন: ৩০" });
  const olderBtn = h("button", { class: "btn btn-outline" }, "এর চেয়ে পুরনো এন্ট্রি ডিলিট করুন (দিন)");
  body.appendChild(h("p", { class: "small muted" }, "এই কাজটি ফিরিয়ে আনা যাবে না।"));
  body.appendChild(allBtn);
  body.appendChild(h("div", { class: "field" }, [h("label", {}, "কতদিনের পুরনো এন্ট্রি ডিলিট করবেন?"), orField]));
  body.appendChild(olderBtn);

  // Auto-purge schedule, shown in the same modal since it's the same
  // concern - lets the admin set-and-forget instead of manually purging.
  body.appendChild(h("hr", {}));
  const autoRow = h("div", { class: "toggle-row" });
  const autoCb = h("input", { type: "checkbox" });
  const autoSw = h("label", { class: "switch" }); autoSw.appendChild(autoCb); autoSw.appendChild(h("span", { class: "track" }));
  autoRow.appendChild(h("div", {}, [h("b", {}, "স্বয়ংক্রিয় পার্জ চালু রাখুন")]));
  autoRow.appendChild(autoSw);
  body.appendChild(autoRow);
  const autoDaysField = h("input", { type: "number", min: "1", placeholder: "৩০" });
  body.appendChild(h("div", { class: "field" }, [h("label", {}, "প্রতি কতদিন পর পুরনো এন্ট্রি স্বয়ংক্রিয়ভাবে ডিলিট হবে?"), autoDaysField]));
  // Toggling this applies instantly (sends the currently-shown day count
  // alongside it, since the endpoint expects both together) - the days
  // field itself still needs the explicit সংরক্ষণ করুন button below since
  // changing a number mid-typing shouldn't fire a save on every keystroke.
  autoCb.onchange = async () => {
    autoCb.disabled = true;
    try {
      const days = parseInt(autoDaysField.value, 10) || 30;
      await API.put("/api/admin/activity-log/auto-purge", { enabled: autoCb.checked, olderThanDays: days });
      toast("সংরক্ষণ করা হয়েছে");
    } catch (e) { autoCb.checked = !autoCb.checked; toast(e.message); }
    finally { autoCb.disabled = false; }
  };
  const saveAutoBtn = h("button", { class: "btn btn-outline btn-sm" }, "সংরক্ষণ করুন");
  body.appendChild(saveAutoBtn);

  API.get("/api/admin/activity-log/auto-purge").then((s) => {
    autoCb.checked = s.enabled;
    autoDaysField.value = s.olderThanDays;
  }).catch(() => {});

  saveAutoBtn.onclick = async () => {
    const days = parseInt(autoDaysField.value, 10);
    if (!Number.isFinite(days) || days < 1) return toast("সঠিক সংখ্যক দিন দিন");
    try {
      await API.put("/api/admin/activity-log/auto-purge", { enabled: autoCb.checked, olderThanDays: days });
      toast("সংরক্ষণ করা হয়েছে");
    } catch (e) { toast(e.message); }
  };

  const cancelBtn = h("button", { class: "btn btn-outline" }, "বাতিল");
  openModal({ title: "এক্টিভিটি লগ পার্জ", body, actions: [cancelBtn] });
  cancelBtn.onclick = closeModal;

  allBtn.onclick = async () => {
    if (!confirm("সম্পূর্ণ এক্টিভিটি লগ ডিলিট করতে চান? এটি ফিরিয়ে আনা যাবে না।")) return;
    try {
      await API.post("/api/admin/activity-log/purge", {});
      toast("লগ পার্জ করা হয়েছে");
      closeModal();
      reload(1);
    } catch (e) { toast(e.message); }
  };
  olderBtn.onclick = async () => {
    const days = parseInt(orField.value, 10);
    if (!Number.isFinite(days) || days < 1) return toast("সঠিক সংখ্যক দিন দিন");
    try {
      await API.post("/api/admin/activity-log/purge", { olderThanDays: days });
      toast("পার্জ সম্পন্ন হয়েছে");
      closeModal();
      reload(currentPage);
    } catch (e) { toast(e.message); }
  };
}

// -------------------------------------------------------------- SMS SETTINGS
ViewsAdmin.smsSettings = async function (view) {
  const content = adminPage(view, "এসএমএস সেটিংস", "/admin/sms");
  const s = await API.get("/api/admin/sms-settings");

  const card = h("div", { class: "card stack" });
  const apiKeyField = h("input", { type: "text" }); apiKeyField.value = s.greensms_api_key || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "GreenSMS API Key (token)"), apiKeyField]));

  const manualOtp = h("input", { type: "text", placeholder: "খালি রাখলে স্বয়ংক্রিয় OTP ব্যবহৃত হবে" }); manualOtp.value = s.manual_otp || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "ম্যানুয়াল OTP (ফিক্সড কোড)"), manualOtp, h("div", { class: "field-hint" }, "সেট করা থাকলে এটিই সব জায়গায় OTP হিসেবে কাজ করবে")]));

  const testModeRow = h("div", { class: "toggle-row" });
  const testModeCb = h("input", { type: "checkbox" }); testModeCb.checked = !!s.otp_test_mode;
  wireInstantToggle(testModeCb, (p) => API.put("/api/admin/sms-settings", p), "otp_test_mode");
  testModeRow.appendChild(h("div", {}, [h("b", {}, "OTP টেস্ট মোড"), h("div", { class: "small muted" }, "এক্টিভ থাকলে ম্যানুয়াল OTP খালি হলে OTP এসএমএস না পাঠিয়ে এক্টিভিটি লগে দেখাবে")]));
  const sw = h("label", { class: "switch" }); sw.appendChild(testModeCb); sw.appendChild(h("span", { class: "track" }));
  testModeRow.appendChild(sw);
  card.appendChild(testModeRow);
  content.appendChild(card);

  // ---- daily SMS limits ----
  const limitCard = h("div", { class: "card stack" });
  limitCard.appendChild(h("h3", {}, "দৈনিক এসএমএস লিমিট"));
  const userLimitField = h("input", { type: "number", min: "0" }); userLimitField.value = s.sms_daily_limit_user_initiated || "3";
  limitCard.appendChild(h("div", { class: "field" }, [h("label", {}, "ইউজার-উদ্যোগী এসএমএস (দৈনিক, প্রতি নাম্বার)"), userLimitField]));
  const systemLimitField = h("input", { type: "number", min: "0" }); systemLimitField.value = s.sms_daily_limit_system || "3";
  limitCard.appendChild(h("div", { class: "field" }, [h("label", {}, "সিস্টেম এসএমএস (দৈনিক, প্রতি নাম্বার)"), systemLimitField]));
  const overLimitMsgField = h("textarea", {}); overLimitMsgField.value = s.sms_over_limit_otp_message || "";
  limitCard.appendChild(h("div", { class: "field" }, [h("label", {}, "লিমিট শেষ হলে OTP পেজে যে মেসেজ দেখানো হবে"), overLimitMsgField]));
  content.appendChild(limitCard);

  // ---- per-type on/off toggles ----
  const toggleCard = h("div", { class: "card stack" });
  toggleCard.appendChild(h("h3", {}, "কোন এসএমএস পাঠানো হবে"));
  const TOGGLE_TYPES = [
    ["sms_enabled_account_created_self", "একাউন্ট তৈরি (নিজে)"],
    ["sms_enabled_account_created_import", "একাউন্ট তৈরি (এডমিন কর্তৃক ইম্পোর্ট)"],
    ["sms_enabled_otp", "OTP"],
    ["sms_enabled_password_reset", "এডমিন কর্তৃক পাসওয়ার্ড রিসেট"],
    ["sms_enabled_eligibility_change_by_call", "কলের কারণে এলিজিবিলিটি পরিবর্তন"],
    ["sms_enabled_donation_reminder", "৪৮ ঘন্টা পর রক্তদান রিমাইন্ডার"],
    ["sms_enabled_eligibility_reopened", "এলিজিবিলিটি পুনরায় শুরু (মেয়াদ শেষ/স্থগিত থেকে চালু)"],
  ];
  const toggleChecks = {};
  TOGGLE_TYPES.forEach(([key, label]) => {
    const row = h("div", { class: "toggle-row" });
    const cb = h("input", { type: "checkbox" }); cb.checked = s[key] !== false;
    toggleChecks[key] = cb;
    wireInstantToggle(cb, (p) => API.put("/api/admin/sms-settings", p), key);
    const tsw = h("label", { class: "switch" }); tsw.appendChild(cb); tsw.appendChild(h("span", { class: "track" }));
    row.appendChild(h("div", {}, label));
    row.appendChild(tsw);
    toggleCard.appendChild(row);
  });
  content.appendChild(toggleCard);

  // ---- templates ----
  const templatesCard = h("div", { class: "card stack" });
  const templates = [
    ["sms_account_created_self", "একাউন্ট তৈরি (নিজে)", ["siteTitle"]],
    ["sms_account_created_import", "একাউন্ট তৈরি (ইম্পোর্ট করা)", ["password"]],
    ["sms_otp", "OTP মেসেজ", ["otp"]],
    ["sms_password_reset_by_admin", "এডমিন কর্তৃক পাসওয়ার্ড রিসেট", ["password"]],
    ["sms_eligibility_change_by_call", "কলের কারণে এলিজিবিলিটি পরিবর্তন", ["status"]],
    ["sms_donation_reminder", "৪৮ ঘন্টা পর রক্তদান রিমাইন্ডার", ["siteTitle"]],
    ["sms_eligibility_reopened", "এলিজিবিলিটি পুনরায় শুরু (মেয়াদ শেষ/স্থগিত থেকে চালু)", ["siteTitle"]],
  ];
  const fields = {};
  templates.forEach(([key, label, vars]) => {
    const f = h("textarea", {}); f.value = s[key] || "";
    fields[key] = f;
    templatesCard.appendChild(h("div", { class: "field" }, [h("label", {}, label), f, h("div", { class: "field-hint" }, `ভ্যারিয়েবল: ${vars.map((v) => "{" + v + "}").join(", ")}`)]));
  });
  content.appendChild(templatesCard);

  const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ করুন");
  content.appendChild(saveBtn);

  saveBtn.onclick = async () => {
    const payload = {
      greensms_api_key: apiKeyField.value, manual_otp: manualOtp.value, otp_test_mode: testModeCb.checked,
      sms_daily_limit_user_initiated: userLimitField.value, sms_daily_limit_system: systemLimitField.value,
      sms_over_limit_otp_message: overLimitMsgField.value,
    };
    Object.entries(fields).forEach(([k, f]) => (payload[k] = f.value));
    Object.entries(toggleChecks).forEach(([k, cb]) => (payload[k] = cb.checked));
    try { await API.put("/api/admin/sms-settings", payload); toast("সংরক্ষণ করা হয়েছে"); }
    catch (e) { toast(e.message); }
  };

  // ---- SMS tester ----
  const testCard = h("div", { class: "card stack" });
  testCard.appendChild(h("h3", {}, "টেস্ট এসএমএস পাঠান"));
  const testMobile = h("input", { type: "tel", maxlength: "11", placeholder: "01XXXXXXXXX" });
  const testTemplate = h("select");
  templates.forEach(([key, label]) => testTemplate.appendChild(h("option", { value: key }, label)));
  testCard.appendChild(h("div", { class: "field" }, [h("label", {}, "মোবাইল নাম্বার"), testMobile]));
  testCard.appendChild(h("div", { class: "field" }, [h("label", {}, "টেমপ্লেট নির্বাচন করুন"), testTemplate]));
  const testResult = h("div", { class: "field-hint" });
  const testBtn = h("button", { class: "btn btn-accent" }, [icon("send", "small"), " টেস্ট পাঠান"]);
  testCard.appendChild(testBtn);
  testCard.appendChild(testResult);
  content.appendChild(testCard);
  enterSubmits(testMobile, testBtn);

  testBtn.onclick = async () => {
    testResult.textContent = "পাঠানো হচ্ছে…";
    testBtn.disabled = true;
    try {
      const res = await API.post("/api/admin/sms-settings/test", { mobile: testMobile.value.trim(), templateKey: testTemplate.value });
      testResult.className = "field-hint";
      testResult.textContent = `পাঠানো হয়েছে: "${res.message}"` + (res.gatewayResponse ? ` — গেটওয়ে রেসপন্স: ${res.gatewayResponse}` : "");
      toast("টেস্ট এসএমএস পাঠানো হয়েছে");
    } catch (e) {
      testResult.className = "field-error";
      testResult.textContent = e.message;
    } finally { testBtn.disabled = false; }
  };
};

// ---------------------------------------------------------------- SITE APIS
// Only actual third-party credentials live here now - /seek system tuning
// (call limits, lock time, OTP-for-number-change) moved to Site Settings.
ViewsAdmin.smsAnalytics = async function (view) {
  const content = adminPage(view, "এসএমএস এনালিটিক্স", "/admin/sms-analytics");
  const resetBtn = h("button", { class: "btn btn-outline btn-sm", style: "color:var(--primary);margin-bottom:12px" }, "রেকর্ড রিসেট করুন");
  content.appendChild(resetBtn);

  const { current, history } = await API.get("/api/admin/sms-analytics");

  const currentCard = h("div", { class: "card stack" });
  currentCard.appendChild(h("h3", {}, "বর্তমান সর্বোচ্চ দৈনিক SMS (এই মাসে)"));
  if (!current.length) {
    currentCard.appendChild(h("p", { class: "muted" }, "এখনো কোনো রেকর্ড নেই"));
  } else {
    current.forEach((u) => currentCard.appendChild(h("div", { class: "list-item" }, [
      h("span", {}, `${u.name || u.mobile} (${u.mobile})`),
      h("span", { class: "muted" }, `${toBnDigits(u.sms_highest_daily_count)} টি এসএমএস — ${bnDate(u.sms_highest_daily_date)}`),
    ])));
  }
  content.appendChild(currentCard);

  const historyCard = h("div", { class: "card stack" });
  historyCard.appendChild(h("h3", {}, "পূর্ববর্তী সর্বোচ্চ দৈনিক SMS রিসিভারস"));
  if (!history.length) {
    historyCard.appendChild(h("p", { class: "muted" }, "কোনো পূর্ববর্তী রেকর্ড নেই"));
  } else {
    history.forEach((h_) => historyCard.appendChild(h("div", { class: "list-item" }, [
      h("span", {}, h_.mobile),
      h("span", { class: "muted" }, `${toBnDigits(h_.count)} টি — ${bnDate(h_.record_date)} (রিসেট: ${bnDate(h_.reset_at)})`),
    ])));
  }
  content.appendChild(historyCard);

  resetBtn.onclick = async () => {
    if (!confirm("সর্বোচ্চ দৈনিক SMS রেকর্ড রিসেট করতে চান? বর্তমান রেকর্ডগুলো পূর্ববর্তী তালিকায় সংরক্ষিত হবে।")) return;
    try {
      await API.post("/api/admin/sms-analytics/reset", {});
      toast("রিসেট করা হয়েছে");
      ViewsAdmin.smsAnalytics(view);
    } catch (e) { toast(e.message); }
  };
};

ViewsAdmin.siteApis = async function (view) {
  const content = adminPage(view, "সাইট এপিআই", "/admin/site-apis");
  const s = await API.get("/api/admin/site-apis");

  const card = h("div", { class: "card stack" });
  const imgbb = h("input", { type: "text" }); imgbb.value = s.imgbb_api_key || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "ImgBB API Key"), imgbb]));

  const donorbdKey = h("input", { type: "text" }); donorbdKey.value = s.donorbd_api_key || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "DonorBD API Key"), donorbdKey]));
  const donorbdUrl = h("input", { type: "text", placeholder: "https://donor.bd" }); donorbdUrl.value = s.donorbd_base_url || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "DonorBD Base URL"), donorbdUrl]));

  const checkRow = h("div", { class: "toggle-row" });
  const checkCb = h("input", { type: "checkbox" }); checkCb.checked = !!s.donorbd_check_before_claim;
  wireInstantToggle(checkCb, (p) => API.put("/api/admin/site-apis", p), "donorbd_check_before_claim");
  const checkSw = h("label", { class: "switch" }); checkSw.appendChild(checkCb); checkSw.appendChild(h("span", { class: "track" }));
  checkRow.appendChild(h("div", {}, [h("b", {}, "ইউজারনেইম ক্লেইমের আগে DonorBD ক্রসচেক প্রয়োজন?")]));
  checkRow.appendChild(checkSw);
  card.appendChild(checkRow);

  const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ করুন");
  card.appendChild(saveBtn);
  content.appendChild(card);

  saveBtn.onclick = async () => {
    try {
      await API.put("/api/admin/site-apis", {
        imgbb_api_key: imgbb.value, donorbd_api_key: donorbdKey.value, donorbd_base_url: donorbdUrl.value,
        donorbd_check_before_claim: checkCb.checked,
      });
      toast("সংরক্ষণ করা হয়েছে");
    } catch (e) { toast(e.message); }
  };

  // Sweep: claims a donor.bd entry for every account whose username_slug
  // is missing or was never successfully registered there
  // (donorbd_slug_registered = 0) - reuses their existing slug if it's
  // still free on donor.bd, otherwise generates and claims a new random
  // one. Separate card since it's an action, not a settings field.
  const sweepCard = h("div", { class: "card stack" });
  sweepCard.appendChild(h("h3", {}, "আনরেজিস্টার্ড ইউজারনেইম ক্লেইম করুন"));
  sweepCard.appendChild(h("p", { class: "small muted" }, "যেসব ইউজারের ইউজারনেইম এখনো donor.bd তে রেজিস্টার্ড হয়নি, তাদের জন্য এখনকার ইউজারনেইম (যদি এভেইলেবল থাকে) অথবা নতুন র‍্যান্ডম ইউজারনেইম ক্লেইম করা হবে।"));
  const sweepBtn = h("button", { class: "btn btn-outline" }, "ক্লেইম করুন");
  const sweepResult = h("div", { style: "margin-top:10px" });
  sweepCard.appendChild(sweepBtn);
  sweepCard.appendChild(sweepResult);
  content.appendChild(sweepCard);

  sweepBtn.onclick = async () => {
    sweepBtn.disabled = true;
    sweepResult.innerHTML = "";
    setLoading(sweepResult);
    try {
      const res = await API.post("/api/admin/claim-unregistered-donorbd-slugs", {});
      sweepResult.innerHTML = "";
      sweepResult.appendChild(h("p", {}, `${toBnDigits(res.fixed)}টি সফল, ${toBnDigits(res.failed)}টি ব্যর্থ।`));
      if (res.details.length) {
        const list = h("div", { class: "stack" });
        res.details.forEach((d) => {
          list.appendChild(h("div", { class: "list-item" }, [
            h("span", {}, d.mobile), h("span", { class: d.ok ? "muted" : "field-error" }, d.ok ? `→ ${d.slug}` : `${d.slug} - ব্যর্থ`),
          ]));
        });
        sweepResult.appendChild(list);
      }
    } catch (e) {
      sweepResult.innerHTML = "";
      toast(e.message);
    } finally {
      sweepBtn.disabled = false;
    }
  };
};

// ------------------------------------------------------------ SITE SETTINGS
ViewsAdmin.siteSettings = async function (view) {
  const content = adminPage(view, "সাইট সেটিংস", "/admin/site-settings");
  const s = await API.get("/api/admin/site-settings");

  const card = h("div", { class: "card stack" });
  const fieldsMap = [
    ["site_title", "সাইট টাইটেল"], ["logo_url", "লোগো URL"], ["favicon_url", "ফেভিকন URL"],
    ["social_preview_url", "সোশ্যাল প্রিভিউ ছবি URL"], ["theme_color", "থিম কালার (hex)"],
    ["welcome_heading", "ওয়েলকাম হেডিং"], ["welcome_subheading", "ওয়েলকাম সাবহেডিং"], ["welcome_small_text", "ছোট লেখা"],
  ];
  const fields = {};
  fieldsMap.forEach(([key, label]) => {
    const f = h("input", { type: "text" }); f.value = s[key] || "";
    fields[key] = f;
    card.appendChild(h("div", { class: "field" }, [h("label", {}, label), f]));
  });

  const shareBaseField = h("input", { type: "text", placeholder: `খালি রাখলে ${location.origin} ব্যবহৃত হবে` });
  shareBaseField.value = s.profile_share_base_url || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "প্রোফাইল শেয়ার URL এর বেস (যেমনঃ নিজস্ব শর্টলিংক ডোমেইন)"), shareBaseField]));

  const waitMonths = h("input", { type: "number", min: "0" }); waitMonths.value = s.eligibility_wait_months;
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "এলিজিবিলিটি টাইমলাইন (মাস, ০ = ম্যানুয়াল)"), waitMonths]));

  const reopenDelayDays = h("input", { type: "number", min: "0" }); reopenDelayDays.value = s.eligibility_reopen_delay_days || "15";
  card.appendChild(h("div", { class: "field" }, [
    h("label", {}, "ম্যানুয়ালি বন্ধ করার কতদিন পর প্রথম রিমাইন্ডার এসএমএস পাঠানো যাবে (দিন)"),
    reopenDelayDays,
  ]));
  const reopenRepeatDays = h("input", { type: "number", min: "0" }); reopenRepeatDays.value = s.eligibility_reopen_repeat_days || "15";
  card.appendChild(h("div", { class: "field" }, [
    h("label", {}, "প্রতি কতদিন পর পর রিমাইন্ডার এসএমএস পুনরায় পাঠানো যাবে (দিন)"),
    reopenRepeatDays,
  ]));

  const whatsappMsgField = h("textarea", {});
  whatsappMsgField.value = s.whatsapp_seek_message || "";
  card.appendChild(h("div", { class: "field" }, [
    h("label", {}, "রক্ত দরকার পেজে হোয়াটসঅ্যাপ মেসেজ (ব্যবহারযোগ্য: {bloodGroup})"),
    whatsappMsgField,
  ]));

  const sessionDays = h("input", { type: "number", min: "1" }); sessionDays.value = s.session_days || "90";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "লগইন সেশন কতদিন মনে রাখবে (দিন)"), sessionDays]));

  const delRow = h("div", { class: "toggle-row" });
  const delCb = h("input", { type: "checkbox" }); delCb.checked = !!s.self_deletion_enabled;
  wireInstantToggle(delCb, (p) => API.put("/api/admin/site-settings", p), "self_deletion_enabled");
  const delSw = h("label", { class: "switch" }); delSw.appendChild(delCb); delSw.appendChild(h("span", { class: "track" }));
  delRow.appendChild(h("div", {}, [h("b", {}, "ইউজার নিজে প্রোফাইল ডিলেট করতে পারবে?")]));
  delRow.appendChild(delSw);
  card.appendChild(delRow);

  const seekRow = h("div", { class: "toggle-row" });
  const seekCb = h("input", { type: "checkbox" }); seekCb.checked = !!s.show_seek_option;
  wireInstantToggle(seekCb, (p) => API.put("/api/admin/site-settings", p), "show_seek_option");
  const seekSw = h("label", { class: "switch" }); seekSw.appendChild(seekCb); seekSw.appendChild(h("span", { class: "track" }));
  seekRow.appendChild(h("div", {}, [h("b", {}, "হোমপেজে \"রক্ত দরকার\" দেখানো হবে?")]));
  seekRow.appendChild(seekSw);
  card.appendChild(seekRow);

  const joinRow = h("div", { class: "toggle-row" });
  const joinCb = h("input", { type: "checkbox" }); joinCb.checked = !!s.show_join_option;
  wireInstantToggle(joinCb, (p) => API.put("/api/admin/site-settings", p), "show_join_option");
  const joinSw = h("label", { class: "switch" }); joinSw.appendChild(joinCb); joinSw.appendChild(h("span", { class: "track" }));
  joinRow.appendChild(h("div", {}, [h("b", {}, "হোমপেজে \"রক্ত দিতে প্রস্তুত\" দেখানো হবে?")]));
  joinRow.appendChild(joinSw);
  card.appendChild(joinRow);

  const logoutRow = h("div", { class: "toggle-row" });
  const logoutCb = h("input", { type: "checkbox" }); logoutCb.checked = !!s.show_logout_button;
  wireInstantToggle(logoutCb, (p) => API.put("/api/admin/site-settings", p), "show_logout_button");
  const logoutSw = h("label", { class: "switch" }); logoutSw.appendChild(logoutCb); logoutSw.appendChild(h("span", { class: "track" }));
  logoutRow.appendChild(h("div", {}, [h("b", {}, "উপরে ডানদিকে লগআউট বাটন দেখানো হবে?"), h("div", { class: "small muted" }, "ডিফল্ট: বন্ধ - সেটিংস পেজেও লগআউট করা যায়")]));
  logoutRow.appendChild(logoutSw);
  card.appendChild(logoutRow);

  content.appendChild(card);

  // ---- seek সিষ্টেম subheading ----
  const seekCard = h("div", { class: "card stack" });
  seekCard.appendChild(h("h3", {}, "সিক সিষ্টেম (/seek)"));

  const otpRow = h("div", { class: "toggle-row" });
  const otpCb = h("input", { type: "checkbox" }); otpCb.checked = !!s.otp_required_for_number_change;
  wireInstantToggle(otpCb, (p) => API.put("/api/admin/site-settings", p), "otp_required_for_number_change");
  const otpSw = h("label", { class: "switch" }); otpSw.appendChild(otpCb); otpSw.appendChild(h("span", { class: "track" }));
  otpRow.appendChild(h("div", {}, [h("b", {}, "মোবাইল পরিবর্তনে OTP আবশ্যক?")]));
  otpRow.appendChild(otpSw);
  seekCard.appendChild(otpRow);

  const callLimitCount = h("input", { type: "number" }); callLimitCount.value = s.call_limit_count;
  const callLimitMinutes = h("input", { type: "number" }); callLimitMinutes.value = s.call_limit_minutes;
  const lockMinutes = h("input", { type: "number" }); lockMinutes.value = s.donor_lock_minutes;
  const timerSeconds = h("input", { type: "number", min: "1" }); timerSeconds.value = s.call_status_timer_seconds || "20";
  seekCard.appendChild(h("div", { class: "field" }, [h("label", {}, "কল লিমিট (সংখ্যা)"), callLimitCount]));
  seekCard.appendChild(h("div", { class: "field" }, [h("label", {}, "কল লিমিট (মিনিট)"), callLimitMinutes]));
  seekCard.appendChild(h("div", { class: "field" }, [h("label", {}, "ডোনার লক সময় (মিনিট)"), lockMinutes]));
  seekCard.appendChild(h("div", { class: "field" }, [h("label", {}, "কল ষ্ট্যাটাস টাইমার (সেকেন্ড)"), timerSeconds]));
  const maskDigits = h("input", { type: "number", min: "2", max: "8" }); maskDigits.value = s.mask_visible_digits || "4";
  seekCard.appendChild(h("div", { class: "field" }, [h("label", {}, "মোবাইল নাম্বার মাস্কে কতটি সংখ্যা দেখানো হবে (শুরুতে)"), maskDigits]));
  content.appendChild(seekCard);

  // ---- reserved usernames ----
  const reservedCard = h("div", { class: "card stack" });
  reservedCard.appendChild(h("h3", {}, "রিজার্ভড ইউজারনেইম"));
  reservedCard.appendChild(h("p", { class: "small muted" }, "কমা দিয়ে আলাদা করুন। সাইটের গুরুত্বপূর্ণ পাথ (যেমন seek, admin) সবসময় রিজার্ভড থাকে - এখানে শুধু অতিরিক্ত নাম যোগ করুন।"));
  const reservedField = h("input", { type: "text", placeholder: "যেমনঃ support, help, official" });
  reservedField.value = s.reserved_usernames || "";
  reservedCard.appendChild(h("div", { class: "field" }, reservedField));
  content.appendChild(reservedCard);

  // ---- default avatars ----
  const avatarCard = h("div", { class: "card stack" });
  avatarCard.appendChild(h("h3", {}, "ডিফল্ট এভাটার"));
  avatarCard.appendChild(h("p", { class: "small muted" }, "প্রোফাইল ছবি ছাড়া ইউজারদের জন্য এলোমেলোভাবে একটি এভাটার ব্যবহৃত হবে। প্রতি লাইনে একটি ছবির URL দিন।"));
  let avatars = [];
  try { avatars = JSON.parse(s.default_avatars_json || "[]"); } catch { avatars = []; }
  const avatarsField = h("textarea", { placeholder: "https://.../avatar1.png" });
  avatarsField.value = avatars.join("\n");
  avatarCard.appendChild(h("div", { class: "field" }, avatarsField));
  content.appendChild(avatarCard);

  const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ করুন");
  content.appendChild(saveBtn);

  saveBtn.onclick = async () => {
    const avatarList = avatarsField.value.split("\n").map((s) => s.trim()).filter(Boolean);
    const payload = {
      eligibility_wait_months: waitMonths.value, eligibility_reopen_delay_days: reopenDelayDays.value, eligibility_reopen_repeat_days: reopenRepeatDays.value,
      whatsapp_seek_message: whatsappMsgField.value,
      self_deletion_enabled: delCb.checked, session_days: sessionDays.value,
      show_seek_option: seekCb.checked, show_join_option: joinCb.checked, show_logout_button: logoutCb.checked, profile_share_base_url: shareBaseField.value,
      otp_required_for_number_change: otpCb.checked, call_limit_count: callLimitCount.value, call_limit_minutes: callLimitMinutes.value,
      donor_lock_minutes: lockMinutes.value, call_status_timer_seconds: timerSeconds.value, mask_visible_digits: maskDigits.value,
      reserved_usernames: reservedField.value,
      default_avatars_json: JSON.stringify(avatarList),
    };
    Object.entries(fields).forEach(([k, f]) => (payload[k] = f.value));
    try {
      await API.put("/api/admin/site-settings", payload);
      toast("সংরক্ষণ করা হয়েছে");
      const settingsRes = await API.get("/api/settings/public");
      APP.settings = settingsRes; applyBranding(); renderTopbar();
    } catch (e) { toast(e.message); }
  };
};

// ----------------------------------------------------- MULTISITE BRANDING
// (মাল্টিসাইট ব্র্যান্ডিং) - lets the admin show a different site title,
// favicon and logo depending on which domain/subdomain a visitor is on
// (e.g. dhaka.example.com vs chittagong.example.com vs the bare default
// domain). OFF by default (existing single-brand behavior unchanged) -
// the master switch at the top must be turned on before any per-domain
// entry actually takes effect (see getBrandForHostname in admin.js /
// handlePublicSettings). The list here intentionally shows ONLY the
// domain name per row - tapping a row opens a popup (openModal) with the
// editable title/logo/favicon fields, rather than expanding inline, per
// spec ("শুধু ডোমেইনের তালিকা... ক্লিক করলে পপআপ").
ViewsAdmin.multisiteBranding = async function (view) {
  const content = adminPage(view, "মাল্টিসাইট ব্র্যান্ডিং", "/admin/multisite-branding");

  const introCard = h("div", { class: "card" });
  introCard.appendChild(h("p", { class: "muted" }, "একই সাইট ভিন্ন ভিন্ন ডোমেইন/সাবডোমেইনে ভিন্ন সাইট টাইটেল, ফেভিকন ও লোগো দিয়ে দেখানোর জন্য। বন্ধ থাকলে সব ডোমেইনে সাইট সেটিংস পেইজের ডিফল্ট টাইটেল/লোগো/ফেভিকন দেখানো হবে।"));
  const toggleRow = h("div", { class: "toggle-row" });
  const enabledCb = h("input", { type: "checkbox" });
  toggleRow.appendChild(h("div", {}, [h("b", {}, "মাল্টিসাইট ব্র্যান্ডিং চালু করুন"), h("div", { class: "small muted" }, "বন্ধ থাকলে নিচের তালিকা সংরক্ষিত থাকবে কিন্তু কার্যকর হবে না")]));
  const sw = h("label", { class: "switch" }); sw.appendChild(enabledCb); sw.appendChild(h("span", { class: "track" }));
  toggleRow.appendChild(sw);
  introCard.appendChild(toggleRow);
  content.appendChild(introCard);

  const listArea = h("div");
  content.appendChild(listArea);

  const addBtn = h("button", { class: "btn btn-primary", style: "margin-top:12px" }, [icon("plus", "small"), " নতুন ডোমেইন যোগ করুন"]);
  content.appendChild(addBtn);

  async function load() {
    const { enabled, brands } = await API.get("/api/admin/multisite-branding");
    enabledCb.checked = enabled;
    enabledCb.onchange = async () => {
      const newValue = enabledCb.checked;
      enabledCb.disabled = true;
      try { await API.post("/api/admin/multisite-branding/toggle", { enabled: newValue }); }
      catch (e) { enabledCb.checked = !newValue; toast(e.message); }
      finally { enabledCb.disabled = false; }
    };

    listArea.innerHTML = "";
    if (!brands.length) {
      listArea.appendChild(h("div", { class: "card center muted" }, "এখনো কোনো ডোমেইন যোগ করা হয়নি।"));
      return;
    }
    brands.forEach((b) => {
      const row = h("div", { class: "card card--clickable row", style: "justify-content:space-between;align-items:center" });
      row.appendChild(h("div", {}, [
        h("b", {}, b.domain),
        h("div", { class: "small muted" }, b.site_title || "(ডিফল্ট টাইটেল ব্যবহৃত হবে)"),
      ]));
      row.appendChild(icon("chevron-right", "small"));
      row.onclick = () => openBrandModal(b);
      listArea.appendChild(row);
    });
  }

  function openBrandModal(existing) {
    const isNew = !existing;
    const domainF = h("input", { type: "text", placeholder: "যেমনঃ dhaka.example.com" });
    domainF.value = existing ? existing.domain : "";
    const titleF = h("input", { type: "text", placeholder: "খালি রাখলে ডিফল্ট সাইট টাইটেল ব্যবহৃত হবে" });
    titleF.value = existing ? (existing.site_title || "") : "";
    const logoF = h("input", { type: "text", placeholder: "খালি রাখলে ডিফল্ট লোগো ব্যবহৃত হবে (URL)" });
    logoF.value = existing ? (existing.logo_url || "") : "";
    const faviconF = h("input", { type: "text", placeholder: "খালি রাখলে ডিফল্ট ফেভিকন ব্যবহৃত হবে (URL)" });
    faviconF.value = existing ? (existing.favicon_url || "") : "";

    const body = h("div", { class: "stack" }, [
      h("div", { class: "field" }, [h("label", {}, "ডোমেইন / সাবডোমেইন"), domainF, h("div", { class: "field-hint" }, "ঠিক যেভাবে ব্রাউজারের URL বারে দেখা যায় (http:// ছাড়া) - যেমনঃ dhaka.example.com")]),
      h("div", { class: "field" }, [h("label", {}, "সাইট টাইটেল"), titleF]),
      h("div", { class: "field" }, [h("label", {}, "লোগো URL"), logoF]),
      h("div", { class: "field" }, [h("label", {}, "ফেভিকন URL"), faviconF]),
    ]);

    const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ");
    const actions = [h("button", { class: "btn btn-outline", onclick: closeModal }, "বাতিল")];
    if (!isNew) {
      actions.push(h("button", {
        class: "btn btn-danger",
        onclick: async () => {
          const sure = await confirmModal(`"${existing.domain}" ডিলিট করবেন?`);
          if (!sure) return;
          try { await API.del(`/api/admin/multisite-branding/${existing.id}`); closeModal(); toast("ডিলিট হয়েছে"); load(); }
          catch (e) { toast(e.message); }
        },
      }, "ডিলিট"));
    }
    actions.push(saveBtn);

    saveBtn.onclick = async () => {
      if (!domainF.value.trim()) { toast("ডোমেইন দিন"); return; }
      const payload = { domain: domainF.value, siteTitle: titleF.value, logoUrl: logoF.value, faviconUrl: faviconF.value };
      try {
        if (isNew) await API.post("/api/admin/multisite-branding", payload);
        else await API.put(`/api/admin/multisite-branding/${existing.id}`, payload);
        closeModal();
        toast("সংরক্ষণ হয়েছে");
        load();
      } catch (e) { toast(e.message); }
    };

    openModal({ title: isNew ? "নতুন ডোমেইন" : existing.domain, body, actions });
  }

  addBtn.onclick = () => openBrandModal(null);

  await load();
};

ViewsAdmin.locations = async function (view) {
  const content = adminPage(view, "লোকেশন লিস্ট", "/admin/locations");
  const listArea = h("div");
  content.appendChild(listArea);

  async function load() {
    listArea.innerHTML = "";
    const { locations } = await API.get("/api/admin/locations");
    const top = locations.filter((l) => !l.parent_id);
    top.forEach((t) => {
      const row = h("div", { class: "card stack" });
      const nameF = h("input", { type: "text" }); nameF.value = t.name;
      row.appendChild(h("div", { class: "row" }, [
        nameF,
        h("button", { class: "btn btn-sm btn-outline", onclick: async () => { await API.put(`/api/admin/locations/${t.id}`, { name: nameF.value, parentId: null, sortOrder: t.sort_order }); toast("আপডেট হয়েছে"); } }, "সংরক্ষণ"),
        h("button", { class: "btn btn-sm btn-danger", onclick: async () => { const sure = await confirmModal("ডিলিট করবেন?"); if (sure) { await API.del(`/api/admin/locations/${t.id}`); load(); } } }, "ডিলিট"),
      ]));
      const children = locations.filter((c) => c.parent_id === t.id);
      children.forEach((c) => {
        const cf = h("input", { type: "text" }); cf.value = c.name;
        row.appendChild(h("div", { class: "row", style: "margin-left:16px" }, [
          h("span", { class: "muted" }, "— "), cf,
          h("button", { class: "btn btn-sm btn-outline", onclick: async () => { await API.put(`/api/admin/locations/${c.id}`, { name: cf.value, parentId: t.id, sortOrder: c.sort_order }); toast("আপডেট হয়েছে"); } }, "সংরক্ষণ"),
          h("button", { class: "btn btn-sm btn-danger", onclick: async () => { const sure = await confirmModal("ডিলিট করবেন?"); if (sure) { await API.del(`/api/admin/locations/${c.id}`); load(); } } }, "ডিলিট"),
        ]));
      });
      const newChild = h("input", { type: "text", placeholder: "নতুন উপ-এলাকা" });
      const addChildBtn = h("button", { class: "btn btn-sm btn-outline", onclick: async () => { if (!newChild.value) return; await API.post("/api/admin/locations", { name: newChild.value, parentId: t.id }); load(); } }, "যোগ করুন");
      row.appendChild(h("div", { class: "row", style: "margin-left:16px" }, [newChild, addChildBtn]));
      listArea.appendChild(row);
    });
  }
  await load();

  const addCard = h("div", { class: "card stack" });
  addCard.appendChild(h("h3", {}, "নতুন এলাকা"));
  const newName = h("input", { type: "text", placeholder: "যেমনঃ ঢাকা শহর" });
  addCard.appendChild(h("div", { class: "field" }, newName));
  const addBtn = h("button", { class: "btn btn-primary" }, "যোগ করুন");
  addCard.appendChild(addBtn);
  enterSubmits(newName, addBtn);
  addBtn.onclick = async () => {
    if (!newName.value) return;
    try { await API.post("/api/admin/locations", { name: newName.value }); newName.value = ""; toast("যোগ হয়েছে"); load(); }
    catch (e) { toast(e.message); }
  };
  content.appendChild(addCard);
};
