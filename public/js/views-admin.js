const ViewsAdmin = {};

const ADMIN_NAV_ITEMS = [
  ["/admin", "layout-dashboard", "এনালিটিক্স"],
  ["/admin/users", "users", "ইউজার লিষ্ট"],
  ["/admin/external-sources", "external-link", "এক্সটার্নাল সোর্সেস"],
  ["/admin/activity-log", "history", "এক্টিভিটি লগ"],
  ["/admin/sms", "message-square", "এসএমএস সেটিংস"],
  ["/admin/site-apis", "key", "সাইট এপিআই"],
  ["/admin/site-settings", "settings-2", "সাইট সেটিংস"],
  ["/admin/locations", "map-pin", "লোকেশন"],
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

// -------------------------------------------------------------- DASHBOARD
ViewsAdmin.dashboard = async function (view) {
  const content = adminPage(view, "এডমিন প্যানেল", "/admin");
  const stats = await API.get("/api/admin/analytics");
  const grid = h("div", { class: "stat-grid" });
  const cards = [
    ["মোট ইউজার", stats.totalUsers], ["মোট ডোনার", stats.totalDonors], ["এলিজিবল ডোনার", stats.totalEligible],
    ["মোট কল", stats.totalCallsMade], ["রক্ত ম্যানেজ হয়েছে", stats.totalManaged], ["স্থগিত ডোনার", stats.totalSnoozed],
  ];
  cards.forEach(([label, num]) => grid.appendChild(h("div", { class: "stat-card" }, [h("div", { class: "num" }, String(num)), h("div", { class: "label" }, label)])));
  content.appendChild(grid);

  const groupCard = h("div", { class: "card" });
  groupCard.appendChild(h("h3", {}, "রক্তের গ্রুপ অনুযায়ী"));
  const table = h("table");
  table.appendChild(h("tr", {}, [h("th", {}, "গ্রুপ"), h("th", {}, "মোট"), h("th", {}, "এলিজিবল")]));
  (stats.byGroup || []).forEach((g) => table.appendChild(h("tr", {}, [h("td", {}, g.blood_group), h("td", {}, String(g.total)), h("td", {}, String(g.eligible || 0))])));
  groupCard.appendChild(h("div", { class: "table-wrap" }, table));
  content.appendChild(groupCard);
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
    [["disable", "নিষ্ক্রিয় করুন"], ["enable", "সক্রিয় করুন"], ["reset_password", "পাসওয়ার্ড রিসেট"], ["delete", "ডিলিট"]]
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
      table.appendChild(h("tr", {}, [
        h("td", {}, cb), h("td", {}, u.mobile), h("td", {}, u.name || "-"), h("td", {}, roleLabel),
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
  area.innerHTML = "";
  const card = h("div", { class: "card stack" });
  card.appendChild(h("h3", {}, `এডিট: ${u.mobile}`));
  const name = h("input", { type: "text" }); name.value = u.name || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "নাম"), name]));

  const isAdmin = h("input", { type: "checkbox" }); isAdmin.checked = !!u.is_admin; isAdmin.disabled = !!u.is_root_admin;
  card.appendChild(h("div", { class: "checkbox-row" }, [isAdmin, h("span", { class: "lbl" }, "এডমিন")]));

  const permsWrap = h("div", { style: "display:" + (u.is_admin ? "block" : "none") });
  const { permissions } = await API.get("/api/admin/permissions");
  const permChecks = permissions.map((p) => {
    const cb = h("input", { type: "checkbox", value: p.key });
    permsWrap.appendChild(h("div", { class: "checkbox-row" }, [cb, h("span", { class: "lbl" }, p.label)]));
    return [cb, p.key];
  });
  card.appendChild(permsWrap);
  isAdmin.onchange = () => (permsWrap.style.display = isAdmin.checked ? "block" : "none");

  const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ করুন");
  const resetBtn = h("button", { class: "btn btn-outline" }, [icon("key-round", "small"), " পাসওয়ার্ড রিসেট"]);
  const disableBtn = h("button", { class: "btn btn-outline" }, u.disabled ? "সক্রিয় করুন" : "নিষ্ক্রিয় করুন");
  const deleteBtn = h("button", { class: "btn btn-danger" }, "ডিলিট");
  card.appendChild(h("div", { class: "btn-row" }, [saveBtn, resetBtn]));
  card.appendChild(h("div", { class: "btn-row", style: "margin-top:8px" }, [disableBtn, deleteBtn]));
  area.appendChild(card);
  refreshIcons();

  saveBtn.onclick = async () => {
    const perms = permChecks.filter(([cb]) => cb.checked).map(([, key]) => key);
    try {
      await API.put(`/api/admin/users/${u.id}`, { name: name.value, isAdmin: isAdmin.checked, permissions: perms });
      toast("আপডেট হয়েছে"); area.innerHTML = ""; onDone();
    } catch (e) { toast(e.message); }
  };
  resetBtn.onclick = () => renderBulkResetPasswordModal([u.id], onDone);
  disableBtn.onclick = async () => {
    try { await API.post("/api/admin/users/bulk", { ids: [u.id], action: u.disabled ? "enable" : "disable" }); toast("আপডেট হয়েছে"); onDone(); }
    catch (e) { toast(e.message); }
  };
  deleteBtn.onclick = async () => {
    const sure = await confirmModal("নিশ্চিতভাবে ডিলিট করবেন?", { title: "ইউজার ডিলিট" });
    if (!sure) return;
    try { await API.del(`/api/admin/users/${u.id}`); toast("ডিলিট হয়েছে"); area.innerHTML = ""; onDone(); }
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

  const toolbar = h("div", { class: "row", style: "flex-wrap:wrap;margin-bottom:12px" });
  const whoField = h("input", { type: "text", placeholder: "কে (নাম/মোবাইল)", style: "flex:1;min-width:140px" });
  const catSelect = h("select");
  [["", "সব ক্যাটাগরি"], ["account", "Account"], ["settings", "Settings"], ["call", "Call"], ["donation", "Donation"], ["admin", "Admin"], ["system", "System"]]
    .forEach(([v, l]) => catSelect.appendChild(h("option", { value: v }, l)));
  const filterBtn = h("button", { class: "btn btn-sm btn-outline" }, "ফিল্টার");
  const refreshBtn = h("button", { class: "btn btn-sm btn-primary" }, [icon("refresh-cw", "small")]);
  toolbar.appendChild(whoField); toolbar.appendChild(catSelect); toolbar.appendChild(filterBtn); toolbar.appendChild(refreshBtn);
  content.appendChild(toolbar);
  enterSubmits(whoField, filterBtn);

  const listArea = h("div");
  content.appendChild(listArea);

  async function load() {
    listArea.innerHTML = "";
    setLoading(listArea);
    const q = new URLSearchParams({ who: whoField.value.trim(), category: catSelect.value }).toString();
    const { entries } = await API.get(`/api/admin/activity-log?${q}`);
    listArea.innerHTML = "";
    if (!entries.length) { listArea.appendChild(h("p", { class: "muted" }, "কোনো লগ পাওয়া যায়নি")); return; }
    entries.forEach((e) => listArea.appendChild(h("div", { class: "list-item" }, [
      h("span", {}, `[${e.category}] ${e.actor_label || "সিস্টেম"}: ${e.action_text}`), h("span", { class: "muted small" }, e.created_at),
    ])));
  }
  filterBtn.onclick = load;
  refreshBtn.onclick = load;
  refreshIcons();
  await load();
};

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
  testModeRow.appendChild(h("div", {}, [h("b", {}, "OTP টেস্ট মোড"), h("div", { class: "small muted" }, "এক্টিভ থাকলে ম্যানুয়াল OTP খালি হলে OTP এসএমএস না পাঠিয়ে এক্টিভিটি লগে দেখাবে")]));
  const sw = h("label", { class: "switch" }); sw.appendChild(testModeCb); sw.appendChild(h("span", { class: "track" }));
  testModeRow.appendChild(sw);
  card.appendChild(testModeRow);
  content.appendChild(card);

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
  ];
  const toggleChecks = {};
  TOGGLE_TYPES.forEach(([key, label]) => {
    const row = h("div", { class: "toggle-row" });
    const cb = h("input", { type: "checkbox" }); cb.checked = s[key] !== false;
    toggleChecks[key] = cb;
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
    const payload = { greensms_api_key: apiKeyField.value, manual_otp: manualOtp.value, otp_test_mode: testModeCb.checked };
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

  const sessionDays = h("input", { type: "number", min: "1" }); sessionDays.value = s.session_days || "90";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "লগইন সেশন কতদিন মনে রাখবে (দিন)"), sessionDays]));

  const delRow = h("div", { class: "toggle-row" });
  const delCb = h("input", { type: "checkbox" }); delCb.checked = !!s.self_deletion_enabled;
  const delSw = h("label", { class: "switch" }); delSw.appendChild(delCb); delSw.appendChild(h("span", { class: "track" }));
  delRow.appendChild(h("div", {}, [h("b", {}, "ইউজার নিজে প্রোফাইল ডিলেট করতে পারবে?")]));
  delRow.appendChild(delSw);
  card.appendChild(delRow);

  const seekRow = h("div", { class: "toggle-row" });
  const seekCb = h("input", { type: "checkbox" }); seekCb.checked = !!s.show_seek_option;
  const seekSw = h("label", { class: "switch" }); seekSw.appendChild(seekCb); seekSw.appendChild(h("span", { class: "track" }));
  seekRow.appendChild(h("div", {}, [h("b", {}, "হোমপেজে \"রক্ত দরকার\" দেখানো হবে?")]));
  seekRow.appendChild(seekSw);
  card.appendChild(seekRow);

  const joinRow = h("div", { class: "toggle-row" });
  const joinCb = h("input", { type: "checkbox" }); joinCb.checked = !!s.show_join_option;
  const joinSw = h("label", { class: "switch" }); joinSw.appendChild(joinCb); joinSw.appendChild(h("span", { class: "track" }));
  joinRow.appendChild(h("div", {}, [h("b", {}, "হোমপেজে \"রক্ত দিতে প্রস্তুত\" দেখানো হবে?")]));
  joinRow.appendChild(joinSw);
  card.appendChild(joinRow);

  const logoutRow = h("div", { class: "toggle-row" });
  const logoutCb = h("input", { type: "checkbox" }); logoutCb.checked = !!s.show_logout_button;
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
  content.appendChild(seekCard);

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
      eligibility_wait_months: waitMonths.value, self_deletion_enabled: delCb.checked, session_days: sessionDays.value,
      show_seek_option: seekCb.checked, show_join_option: joinCb.checked, show_logout_button: logoutCb.checked, profile_share_base_url: shareBaseField.value,
      otp_required_for_number_change: otpCb.checked, call_limit_count: callLimitCount.value, call_limit_minutes: callLimitMinutes.value,
      donor_lock_minutes: lockMinutes.value, call_status_timer_seconds: timerSeconds.value,
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

// ----------------------------------------------------------------- LOCATIONS
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
