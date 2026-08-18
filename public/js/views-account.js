const ViewsAccount = {};

// ------------------------------------------------------------------ QUICK
ViewsAccount.quick = async function (view) {
  const status = await API.get("/api/donor/status");
  const { eligibilityStatus, snoozeUntil, snoozeReason, note, lastEligibilityChangeNote, pendingDonationPrompt } = status;
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "আমার অবস্থা"));

  // If the last call outcome was "রক্ত দিতে পারবে", the donation-entry
  // section moves to position 1 with an extra "না, সম্প্রতি রক্তদান করিনি"
  // escape hatch. Otherwise it stays in its normal position 3.
  const sections = { toggle: renderEligibilityToggleSection, note: renderNoteSection, donation: renderDonationPromptSection, mobile: renderMobileChangeSection, location: renderLocationChangeSection };
  const order = pendingDonationPrompt
    ? ["donation", "toggle", "note", "mobile", "location"]
    : ["toggle", "note", "donation", "mobile", "location"];

  if (lastEligibilityChangeNote) {
    view.appendChild(h("div", { class: "banner", style: "background:var(--surface-2);color:var(--ink-soft)" }, lastEligibilityChangeNote));
  }

  for (const key of order) {
    await sections[key](view, status);
  }
};

async function renderEligibilityToggleSection(view, status) {
  const { eligibilityStatus, snoozeUntil, snoozeReason } = status;
  const card = h("div", { class: "card" });
  const toggleRow = h("div", { class: "toggle-row" });
  const badge = h("span", {
    class: "badge " + (eligibilityStatus === "on" ? "badge-on" : eligibilityStatus === "snoozed" ? "badge-snoozed" : "badge-off"),
  }, eligibilityStatus === "on" ? "চালু আছে" : eligibilityStatus === "snoozed" ? "সাময়িক বন্ধ" : "বন্ধ");
  const switchWrap = h("label", { class: "switch" });
  const cb = h("input", { type: "checkbox" });
  cb.checked = eligibilityStatus === "on";
  switchWrap.appendChild(cb);
  switchWrap.appendChild(h("span", { class: "track" }));
  toggleRow.appendChild(h("div", {}, [h("b", {}, "রক্তদানের জন্য প্রস্তুত"), badge]));
  toggleRow.appendChild(switchWrap);
  card.appendChild(toggleRow);

  const snoozeArea = h("div", { style: "margin-top:12px" });
  card.appendChild(snoozeArea);
  view.appendChild(card);

  if (eligibilityStatus === "snoozed" && snoozeUntil) {
    snoozeArea.appendChild(renderCountdown(snoozeUntil, snoozeReason));
  }

  cb.onchange = async () => {
    if (cb.checked) {
      try {
        await API.post("/api/donor/eligibility", { action: "on" });
        toast("এলিজিবিলিটি চালু হয়েছে");
        ViewsAccount.quick(view);
      } catch (e) { toast(e.message); cb.checked = false; }
    } else {
      renderSnoozeOptions(snoozeArea, view);
    }
  };
}

async function renderNoteSection(view, status) {
  const noteCard = h("div", { class: "card stack" });
  noteCard.appendChild(h("h3", {}, "নোট আপডেট"));
  const noteField = h("textarea", { placeholder: "যেমনঃ ২ ঘন্টা আগে জানাবেন" });
  noteField.value = status.note || "";
  noteCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন নোট"), noteField]));
  const noteBtn = h("button", { class: "btn btn-outline" }, "আপডেট");
  noteCard.appendChild(noteBtn);
  noteBtn.onclick = async () => {
    try { await API.post("/api/donor/note", { note: noteField.value }); toast("নোট আপডেট হয়েছে"); }
    catch (e) { toast(e.message); }
  };
  view.appendChild(noteCard);
}

async function renderDonationPromptSection(view, status) {
  const donCard = h("div", { class: "card stack" });
  donCard.appendChild(h("h3", {}, "রক্তদান করেছেন?"));
  if (status.pendingDonationPrompt) {
    donCard.appendChild(h("p", { class: "small muted" }, "সাম্প্রতিক একটি কলে আপনি জানিয়েছিলেন যে রক্ত দিতে পারবেন। রক্তদান হয়ে থাকলে নিচে তথ্য দিন।"));
  }
  const hospField = h("input", { type: "text", placeholder: "ঐচ্ছিক" });
  const dateField = h("input", { type: "date", max: todayIsoDate() });
  dateField.value = todayIsoDate();
  donCard.appendChild(h("div", { class: "field" }, [h("label", {}, "হাসপাতালের নাম (ঐচ্ছিক)"), hospField]));
  donCard.appendChild(h("div", { class: "field" }, [h("label", {}, "তারিখ"), dateField]));
  const donBtn = h("button", { class: "btn btn-accent" }, "সাবমিট");
  donCard.appendChild(donBtn);
  donBtn.onclick = async () => {
    try {
      await API.post("/api/donor/direct-donation", { hospitalName: hospField.value || null, date: dateField.value });
      toast("ধন্যবাদ! তথ্য সংরক্ষণ করা হয়েছে।");
      ViewsAccount.quick(view);
    } catch (e) { toast(e.message); }
  };
  if (status.pendingDonationPrompt) {
    const noBtn = h("button", { class: "btn btn-outline" }, "না, সম্প্রতি রক্তদান করিনি");
    donCard.appendChild(noBtn);
    noBtn.onclick = async () => {
      try {
        await API.post("/api/donor/dismiss-donation-prompt");
        toast("এলিজিবিলিটি পুনরায় চালু করা হয়েছে");
        ViewsAccount.quick(view);
      } catch (e) { toast(e.message); }
    };
  }
  view.appendChild(donCard);
}

async function renderMobileChangeSection(view, status) {
  const s = APP.settings || {};
  const otpRequired = s.otpRequiredForNumberChange !== false;
  const mobCard = h("div", { class: "card stack" });
  mobCard.appendChild(h("h3", {}, "মোবাইল নাম্বার পরিবর্তন"));
  const newMobField = h("input", { type: "tel", maxlength: "11", placeholder: "নতুন মোবাইল নাম্বার" });
  const availHint = h("div", { class: "field-hint" });

  let otpField = null;
  if (otpRequired) {
    // OTP-related UI is hidden entirely when the admin has turned the
    // requirement off, rather than shown-but-optional.
    const sendOtpBtn = h("button", { class: "btn-sm btn btn-outline" }, "OTP পাঠান");
    otpField = h("input", { type: "text", maxlength: "6", placeholder: "ওটিপি কোড" });
    mobCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন মোবাইল নাম্বার"), h("div", { class: "row" }, [newMobField, sendOtpBtn]), availHint]));
    mobCard.appendChild(h("div", { class: "field" }, [h("label", {}, "ওটিপি কোড"), otpField]));
    sendOtpBtn.onclick = async () => {
      const mobile = newMobField.value.trim();
      if (!/^01[3-9]\d{8}$/.test(mobile)) return toast("সঠিক মোবাইল নাম্বার দিন");
      try {
        const { available } = await API.get(`/api/donor/check-new-mobile?mobile=${mobile}`);
        if (!available) { availHint.textContent = "এই মোবাইল নাম্বার ইতিমধ্যে ব্যবহৃত হচ্ছে"; availHint.className = "field-error"; return; }
        availHint.textContent = "";
        await API.post("/api/otp/send", { mobile, purpose: "change_mobile" });
        toast("OTP পাঠানো হয়েছে");
      } catch (e) { toast(e.message); }
    };
  } else {
    mobCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন মোবাইল নাম্বার"), newMobField, availHint]));
  }

  const mobBtn = h("button", { class: "btn btn-outline" }, "আপডেট");
  mobCard.appendChild(mobBtn);
  mobBtn.onclick = async () => {
    const mobile = newMobField.value.trim();
    try {
      if (!otpRequired) {
        const { available } = await API.get(`/api/donor/check-new-mobile?mobile=${mobile}`);
        if (!available) { availHint.textContent = "এই মোবাইল নাম্বার ইতিমধ্যে ব্যবহৃত হচ্ছে"; availHint.className = "field-error"; return; }
      }
      await API.post("/api/donor/change-mobile", { newMobile: mobile, otp: otpField ? otpField.value : "" });
      toast("মোবাইল নাম্বার পরিবর্তন হয়েছে");
    } catch (e) { availHint.textContent = e.message; availHint.className = "field-error"; }
  };
  view.appendChild(mobCard);
}

async function renderLocationChangeSection(view, status) {
  const locCard = h("div", { class: "card stack" });
  locCard.appendChild(h("h3", {}, "এলাকা পরিবর্তন"));
  const locSelect = h("select");
  await locationOptions(locSelect);
  const addrField2 = h("input", { type: "text", placeholder: "সংক্ষিপ্ত ঠিকানা" });
  locCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন এলাকা"), locSelect]));
  locCard.appendChild(h("div", { class: "field" }, [h("label", {}, "সংক্ষিপ্ত ঠিকানা"), addrField2]));
  const locBtn = h("button", { class: "btn btn-outline" }, "আপডেট");
  locCard.appendChild(locBtn);
  locBtn.onclick = async () => {
    try {
      await API.post("/api/donor/change-location", { locationId: locSelect.value || null, addressSummary: addrField2.value });
      toast("এলাকা আপডেট হয়েছে");
    } catch (e) { toast(e.message); }
  };
  view.appendChild(locCard);
}

function renderCountdown(untilIso, reason) {
  const wrap = h("div", { class: "banner banner-error", style: "background:var(--warn-tint);color:var(--warn);border-color:var(--warn)" });
  const label = h("span", {});
  wrap.appendChild(h("div", {}, reason ? `কারণ: ${reason}` : ""));
  wrap.appendChild(label);
  const target = new Date(untilIso.replace(" ", "T")).getTime();
  let interval = null;
  const tick = () => {
    const diff = target - Date.now();
    if (diff <= 0) { label.textContent = "সময় শেষ - শীঘ্রই স্বয়ংক্রিয়ভাবে চালু হবে"; if (interval) clearInterval(interval); return; }
    label.textContent = `স্বয়ংক্রিয়ভাবে চালু হতে বাকি: ${bnDuration(Date.now(), target)}`;
  };
  tick();
  interval = setInterval(tick, 1000);
  return wrap;
}

function renderSnoozeOptions(container, view) {
  container.innerHTML = "";
  const opts = [
    { key: "today_off", label: "আজকের জন্য বন্ধ" },
    { key: "2h", label: "২ঘন্টার জন্য স্থগিত" },
    { key: "6h", label: "৬ ঘন্টার জন্য স্থগিত" },
    { key: "until_date", label: "তারিখ পর্যন্ত স্থগিত" },
    { key: "indefinite", label: "যতদিন আমি নিজে চালু না করি" },
  ];
  const wrap = h("div", { class: "stack" });
  wrap.appendChild(h("p", { class: "small muted" }, "কতক্ষণের জন্য বন্ধ রাখতে চান?"));
  opts.forEach((o) => {
    wrap.appendChild(h("button", { class: "btn btn-outline", onclick: () => onSnoozeChoice(o.key, view) }, o.label));
  });
  container.appendChild(wrap);
}

async function onSnoozeChoice(key, view) {
  if (key === "until_date") {
    const dateInput = h("input", { type: "date", min: todayIsoDate() });
    const body = h("div", { class: "field" }, [h("label", {}, "কোন তারিখ পর্যন্ত স্থগিত রাখতে চান?"), dateInput]);
    const okBtn = h("button", { class: "btn btn-primary" }, "নিশ্চিত করুন");
    const cancelBtn = h("button", { class: "btn btn-outline" }, "বাতিল");
    openModal({ title: "তারিখ নির্বাচন করুন", body, actions: [cancelBtn, okBtn] });
    cancelBtn.onclick = closeModal;
    okBtn.onclick = async () => {
      if (!dateInput.value) return;
      closeModal();
      await submitSnooze(key, dateInput.value, view);
    };
    return;
  }
  await submitSnooze(key, null, view);
}

async function submitSnooze(key, snoozeDate, view) {
  try {
    await API.post("/api/donor/eligibility", { action: "off", snoozeType: key, snoozeDate });
    toast("আপডেট হয়েছে");
    ViewsAccount.quick(view);
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- PROFILE
ViewsAccount.profile = async function (view) {
  const { profile } = await API.get("/api/profile/me");
  view.innerHTML = "";

  const head = h("div", { class: "card donor-card" });
  head.appendChild(h("img", { class: "donor-card__pic", src: profile.profilePicUrl || pickDefaultAvatar(), alt: "" }));
  head.appendChild(h("div", { class: "donor-card__name" }, profile.name || profile.mobile));
  if (profile.isDonor) {
    const meta = profile.totalDonations > 0 ? `${profile.bloodGroup} (${toBnDigits(profile.totalDonations)} বার রক্তদান)` : (profile.bloodGroup || "");
    const metaEl = h("div", { class: "donor-card__meta", id: "donationCounterMeta" }, meta);
    head.appendChild(metaEl);
  }
  if (profile.note) head.appendChild(h("div", { class: "donor-card__note" }, `নোট: ${profile.note}`));
  view.appendChild(head);

  // অন্যান্য is the ONLY tab for non-donors - other tabs are hidden entirely.
  const tabDefs = profile.isDonor
    ? [["info", "ডোনারের তথ্য"], ["donations", "পূর্বের ডোনেশনসমূহ"], ["calls", "কল হিষ্ট্রি"], ["other", "অন্যান্য"]]
    : [["other", "অন্যান্য"]];

  const tabs = h("div", { class: "tabs" });
  const tabBtns = {};
  tabDefs.forEach(([key, label], i) => {
    const btn = h("button", { class: i === 0 ? "active" : "" }, label);
    tabBtns[key] = btn;
    tabs.appendChild(btn);
  });
  if (tabDefs.length > 1) view.appendChild(tabs);

  const body = h("div");
  view.appendChild(body);

  if (profile.isDonor) {
    view.appendChild(h("div", { class: "btn-row", style: "margin-top:16px" }, [
      h("a", { href: "/profile/edit", "data-link": "", class: "btn btn-primary" }, "এডিট প্রোফাইল"),
      h("a", { href: "/profile/privacy", "data-link": "", class: "btn btn-outline" }, "গোপনীয়তা সেটিংস"),
    ]));
  } else {
    view.appendChild(h("div", { class: "btn-row", style: "margin-top:16px" }, [
      h("a", { href: "/profile/edit", "data-link": "", class: "btn btn-primary" }, "এডিট প্রোফাইল"),
    ]));
  }

  function setTab(key) {
    Object.entries(tabBtns).forEach(([k, b]) => b.classList.toggle("active", k === key));
    body.innerHTML = "";
    if (key === "info") renderInfoTab(body, profile);
    if (key === "donations") renderDonationsTab(body, profile);
    if (key === "calls") renderProfileCallsTab(body, true);
    if (key === "other") renderOtherTab(body, profile);
  }
  Object.keys(tabBtns).forEach((key) => (tabBtns[key].onclick = () => setTab(key)));
  setTab(tabDefs[0][0]);
};

function renderInfoTab(body, profile) {
  const card = h("div", { class: "card stack" });
  const hasUsername = !!profile.username;
  const shareBase = (APP.settings && APP.settings.profileShareBaseUrl) || location.origin;
  const shareUrl = hasUsername ? `${shareBase.replace(/\/$/, "")}/${profile.username}` : null;

  if (hasUsername) {
    const urlRow = h("div", { class: "row" });
    urlRow.appendChild(h("b", {}, "প্রোফাইল URL: "));
    urlRow.appendChild(h("a", { href: shareUrl, style: "flex:1" }, shareUrl));
    const copyBtn = h("button", { class: "btn-ghost", title: "কপি করুন", onclick: () => { navigator.clipboard?.writeText(shareUrl); toast("লিংক কপি হয়েছে"); } }, icon("copy", "small"));
    const editBtn = h("button", { class: "btn-ghost", title: "ইউজারনেইম পরিবর্তন করুন", onclick: () => toggleUsernameEditor(card, profile) }, icon("pencil", "small"));
    urlRow.appendChild(copyBtn);
    urlRow.appendChild(editBtn);
    card.appendChild(urlRow);
  }

  if (profile.addressSummary) card.appendChild(h("div", {}, [h("b", {}, "সংক্ষিপ্ত ঠিকানা: "), profile.addressSummary]));
  if (profile.lastDonationDate) card.appendChild(h("div", {}, [h("b", {}, "সর্বশেষ রক্তদান: "), bnDate(profile.lastDonationDate)]));
  if (profile.locationName) card.appendChild(h("div", {}, [h("b", {}, "লোকেশন: "), profile.locationName]));
  card.appendChild(h("div", {}, [h("b", {}, "মোবাইল: "), profile.mobile]));

  const eligLabel = { on: "চালু আছে", snoozed: "সাময়িক বন্ধ", off: "বন্ধ" }[profile.eligibilityStatus] || profile.eligibilityStatus;
  const eligRow = h("div", {}, [h("b", {}, "বর্তমান এলিজিবিলিটি: "), h("span", { class: "badge " + (profile.eligibilityStatus === "on" ? "badge-on" : profile.eligibilityStatus === "snoozed" ? "badge-snoozed" : "badge-off") }, eligLabel)]);
  card.appendChild(eligRow);
  if (profile.eligibilityStatus === "snoozed" && profile.eligibilitySnoozeUntil) {
    card.appendChild(renderCountdown(profile.eligibilitySnoozeUntil, profile.eligibilitySnoozeReason));
  }

  body.appendChild(card);

  const usernameEditorWrap = h("div", { style: "display:none" });
  card.appendChild(usernameEditorWrap);

  if (!hasUsername) {
    // First-time claim stays an always-visible open section (not behind the
    // pencil icon, since there's nothing to show/hide yet).
    const claimCard = h("div", { class: "card stack" });
    claimCard.appendChild(h("h3", {}, "ইউজারনেইম নির্বাচন করুন"));
    const slugField = h("input", { type: "text", placeholder: "যেমনঃ morshed_alam" });
    const hint = h("div", { class: "field-hint" });
    const claimBtn = h("button", { class: "btn btn-outline" }, "নিশ্চিত করুন");
    claimCard.appendChild(h("div", { class: "field" }, [slugField, hint]));
    claimCard.appendChild(claimBtn);
    enterSubmits(slugField, claimBtn);
    claimBtn.onclick = async () => {
      try {
        await API.post("/api/profile/username", { slug: slugField.value.trim() });
        toast("ইউজারনেইম সেট হয়েছে");
        APP.user.username = slugField.value.trim();
        navigate("/" + APP.user.username);
      } catch (e) { hint.textContent = e.message; hint.className = "field-error"; }
    };
    body.appendChild(claimCard);
  }
}

function toggleUsernameEditor(card, profile) {
  const wrap = card.lastChild; // the usernameEditorWrap placeholder appended in renderInfoTab
  if (wrap.style.display === "block") { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
  wrap.innerHTML = "";
  wrap.style.display = "block";
  const slugField = h("input", { type: "text", placeholder: "নতুন ইউজারনেইম" });
  const hint = h("div", { class: "field-hint" });
  const updateBtn = h("button", { class: "btn btn-sm btn-outline" }, "পরিবর্তন করুন");
  wrap.appendChild(h("div", { class: "field", style: "margin-top:10px" }, [h("label", {}, "নতুন ইউজারনেইম"), slugField, hint]));
  wrap.appendChild(updateBtn);
  enterSubmits(slugField, updateBtn);
  updateBtn.onclick = async () => {
    const newSlug = slugField.value.trim();
    if (!newSlug) return;
    try {
      await API.post("/api/profile/username", { slug: newSlug });
      toast("ইউজারনেইম পরিবর্তন হয়েছে");
      APP.user.username = newSlug;
      navigate("/" + newSlug);
    } catch (e) { hint.textContent = e.message; hint.className = "field-error"; }
  };
}

// -------------------------------------------------------------- DONATIONS
// Rewritten per spec: no more "count-as-extra adds +2" bug, no separate
// bulk-count section. Each dated entry can independently mark its date
// and/or hospital as unknown; if date is unknown, an additional checkbox
// lets the donor declare there are MORE undated donations, in which case
// they provide the grand total (replacing, not adding to, the bucket).
async function renderDonationsTab(body, profile) {
  const { donations, extraCount } = await API.get("/api/profile/donations");
  const card = h("div", { class: "card stack" });
  donations.forEach((d) => card.appendChild(h("div", { class: "list-item" }, [
    h("span", {}, bnDate(d.donation_date)), h("span", { class: "muted" }, d.hospital_name || ""),
  ])));
  if (extraCount > 0) card.appendChild(h("p", { class: "muted small" }, `…এবং আরো ${toBnDigits(extraCount)} বার`));
  if (!donations.length && !extraCount) card.appendChild(h("p", { class: "muted" }, "কোনো তথ্য নেই"));
  body.appendChild(card);

  const addCard = h("div", { class: "card stack" });
  addCard.appendChild(h("h3", {}, "ডোনেশন তথ্য সংযোজন"));

  const dateField = h("input", { type: "date", max: todayIsoDate() });
  const dateUnknownCb = h("input", { type: "checkbox" });
  addCard.appendChild(h("div", { class: "field" }, [h("label", {}, "তারিখ"), dateField]));
  addCard.appendChild(h("div", { class: "checkbox-row" }, [dateUnknownCb, h("span", { class: "lbl" }, "মনে নেই")]));

  const hospField = h("input", { type: "text", placeholder: "হাসপাতালের নাম" });
  const hospUnknownCb = h("input", { type: "checkbox" });
  addCard.appendChild(h("div", { class: "field" }, [h("label", {}, "হাসপাতালের নাম"), hospField]));
  addCard.appendChild(h("div", { class: "checkbox-row" }, [hospUnknownCb, h("span", { class: "lbl" }, "মনে নেই")]));

  const moreUnknownWrap = h("div", { style: "display:none" });
  const moreUnknownCb = h("input", { type: "checkbox" });
  moreUnknownWrap.appendChild(h("div", { class: "checkbox-row" }, [moreUnknownCb, h("span", { class: "lbl" }, "এমন মনে না থাকা ডোনেশন আরো রয়েছে")]));
  const totalUnknownWrap = h("div", { style: "display:none" });
  const totalUnknownField = h("input", { type: "number", min: "1" });
  totalUnknownWrap.appendChild(h("div", { class: "field" }, [h("label", {}, "এমন মনে না থাকা ডোনেশন এর সংখ্যা কত? (এটিসহ সর্বমোট):"), totalUnknownField]));
  moreUnknownWrap.appendChild(totalUnknownWrap);
  addCard.appendChild(moreUnknownWrap);

  dateField.disabled = false;
  const syncDateUnknown = () => {
    dateField.disabled = dateUnknownCb.checked;
    if (dateUnknownCb.checked) dateField.value = "";
    moreUnknownWrap.style.display = dateUnknownCb.checked ? "block" : "none";
    if (!dateUnknownCb.checked) { moreUnknownCb.checked = false; totalUnknownWrap.style.display = "none"; }
  };
  dateUnknownCb.onchange = syncDateUnknown;
  hospField.disabled = false;
  hospUnknownCb.onchange = () => { hospField.disabled = hospUnknownCb.checked; if (hospUnknownCb.checked) hospField.value = ""; };
  moreUnknownCb.onchange = () => { totalUnknownWrap.style.display = moreUnknownCb.checked ? "block" : "none"; };

  const addBtn = h("button", { class: "btn btn-accent" }, "যোগ করুন");
  addCard.appendChild(addBtn);
  addBtn.onclick = async () => {
    if (!dateUnknownCb.checked && !dateField.value) return toast("তারিখ দিন, অথবা 'মনে নেই' নির্বাচন করুন");
    if (dateUnknownCb.checked && moreUnknownCb.checked && !totalUnknownField.value) return toast("সংখ্যা দিন");
    try {
      await API.post("/api/profile/donations", {
        date: dateField.value || null,
        dateUnknown: dateUnknownCb.checked,
        hospitalName: hospField.value || null,
        hospitalUnknown: hospUnknownCb.checked,
        moreUnknownExist: moreUnknownCb.checked,
        totalUnknownCount: totalUnknownField.value ? parseInt(totalUnknownField.value, 10) : undefined,
      });
      toast("যোগ করা হয়েছে");
      // Live-update the donation counter under the profile picture without
      // requiring a page refresh.
      refreshDonationCounter();
      body.innerHTML = "";
      renderDonationsTab(body, profile);
    } catch (e) { toast(e.message); }
  };
  body.appendChild(addCard);
}

async function refreshDonationCounter() {
  try {
    const { profile } = await API.get("/api/profile/me");
    const el = document.getElementById("donationCounterMeta");
    if (el) el.textContent = profile.totalDonations > 0 ? `${profile.bloodGroup} (${toBnDigits(profile.totalDonations)} বার রক্তদান)` : (profile.bloodGroup || "");
  } catch { /* non-fatal */ }
}

async function renderProfileCallsTab(body, isSelf) {
  const { received, made } = await API.get("/api/calls/history");
  const card = h("div", { class: "card stack" });
  if (!received.length && !made.length) card.appendChild(h("p", { class: "muted" }, "কোনো কল হিষ্ট্রি নেই"));
  [...received, ...made].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).forEach((c) => {
    const isMade = "donorLabel" in c;
    const label = isMade ? c.donorLabel : c.requesterLabel;
    const slug = isMade ? c.donorSlug : c.requesterSlug;
    const rest = c.text.replace(label, "").trim();
    card.appendChild(h("div", { class: "list-item" }, h("span", {}, [personLink(label, slug), " " + rest])));
  });
  body.appendChild(card);
}

function renderOtherTab(body, profile) {
  const card = h("div", { class: "card stack" });
  card.appendChild(h("div", {}, [h("b", {}, "প্ল্যাটফর্মে জয়েন করেছেন: "), bnDate(profile.createdAt)]));
  card.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল করেছেন: "), toBnDigits(profile.totalCallsMade)]));
  if (profile.donorsManagedCount > 0) card.appendChild(h("div", {}, [h("b", {}, "রক্তদাতা পেয়েছেন: "), `${toBnDigits(profile.donorsManagedCount)} বার`]));
  if (profile.isDonor) card.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল রিসিভ করেছেন: "), toBnDigits(profile.totalCallsReceived)]));
  if (profile.locationName) card.appendChild(h("div", {}, [h("b", {}, "লোকেশন: "), profile.locationName]));
  body.appendChild(card);

  if (!profile.isDonor) {
    const becomeCard = h("div", { class: "card center stack" });
    becomeCard.appendChild(h("p", {}, "আপনি কি রক্তদাতা হতে চান?"));
    becomeCard.appendChild(h("a", { href: "/join", "data-link": "", class: "btn btn-accent" }, "ডোনার হোন"));
    body.appendChild(becomeCard);
  } else {
    const offCard = h("div", { class: "card stack" });
    offCard.appendChild(h("h3", {}, "ডোনার মোড"));
    offCard.appendChild(h("p", { class: "small muted" }, "ডোনার মোড বন্ধ করলে আপনার এলিজিবিলিটি ও ডোনার সংক্রান্ত ফিচার বন্ধ হয়ে যাবে।"));
    const offBtn = h("button", { class: "btn btn-outline" }, "ডোনার মোড বন্ধ করুন");
    offCard.appendChild(offBtn);
    offBtn.onclick = async () => {
      const sure = await confirmModal("আপনি কি নিশ্চিতভাবে ডোনার মোড বন্ধ করতে চান?", { title: "ডোনার মোড বন্ধ" });
      if (!sure) return;
      try {
        await API.post("/api/donor/mode-off");
        APP.user.isDonor = false;
        toast("ডোনার মোড বন্ধ করা হয়েছে");
        navigate("/profile");
      } catch (e) { toast(e.message); }
    };
    body.appendChild(offCard);
  }
}

// ------------------------------------------------------------ PROFILE EDIT
ViewsAccount.profileEdit = async function (view) {
  const { profile } = await API.get("/api/profile/me");
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "এডিট প্রোফাইল"));
  const card = h("div", { class: "card stack" });

  const picPreview = h("img", { class: "donor-card__pic", src: profile.profilePicUrl || pickDefaultAvatar(), alt: "", style: "margin:0 0 10px" });
  const picInput = h("input", { type: "file", accept: "image/*" });
  card.appendChild(h("div", { class: "center" }, [picPreview, picInput]));
  let picBase64 = null;
  picInput.onchange = async () => {
    if (picInput.files[0]) {
      picBase64 = await fileToBase64(picInput.files[0]);
      picPreview.src = URL.createObjectURL(picInput.files[0]);
    }
  };

  const nameField = h("input", { type: "text" }); nameField.value = profile.name || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "নাম"), nameField]));

  let bloodGroup = profile.bloodGroup;
  if (profile.isDonor) card.appendChild(h("div", { class: "field" }, [h("label", {}, "রক্তের গ্রুপ"), bloodGroupGrid(bloodGroup, (g) => (bloodGroup = g))]));

  const dateField = h("input", { type: "date", max: todayIsoDate() }); dateField.value = profile.lastDonationDate || "";
  if (profile.isDonor) card.appendChild(h("div", { class: "field" }, [h("label", {}, "সর্বশেষ রক্তদানের তারিখ"), dateField]));

  const locSelect = h("select");
  await locationOptions(locSelect, profile.locationId);
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "এলাকা"), locSelect]));

  const addrField = h("input", { type: "text" }); addrField.value = profile.addressSummary || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "সংক্ষিপ্ত ঠিকানা"), addrField]));

  // Note is allowed to be empty - saving a blank note is an explicit choice, not an error.
  const noteField = h("textarea", { placeholder: "খালি রাখতে পারেন" }); noteField.value = profile.note || "";
  if (profile.isDonor) card.appendChild(h("div", { class: "field" }, [h("label", {}, "নোট"), noteField]));

  const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ করুন");
  card.appendChild(saveBtn);
  view.appendChild(card);

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const payload = { name: nameField.value, addressSummary: addrField.value, locationId: locSelect.value || null };
      if (profile.isDonor) { payload.bloodGroup = bloodGroup; payload.lastDonationDate = dateField.value || null; payload.note = noteField.value; }
      if (picBase64) payload.profilePicBase64 = picBase64;
      await API.put("/api/profile/edit", payload);
      toast("প্রোফাইল আপডেট হয়েছে");
      navigate("/profile");
    } catch (e) { toast(e.message); } finally { saveBtn.disabled = false; }
  };
};

// --------------------------------------------------------- PROFILE PRIVACY
ViewsAccount.profilePrivacy = async function (view) {
  const { profile } = await API.get("/api/profile/me");
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "প্রোফাইল তথ্যের গোপনীয়তা সেটিংস"));
  view.appendChild(h("p", { class: "muted small" }, "নাম ও ইউজারনেইম সবসময় পাবলিক থাকবে।"));

  // Fields allowing "শুধুমাত্র রোগী" (visible only inside the active /seek
  // flow), vs fields that only offer public/login/hidden (no patients-only
  // tier - doesn't make sense for a whole tab or the note).
  const PATIENT_TIER_FIELDS = [
    ["mobile", "মোবাইল নাম্বার"], ["address_summary", "সংক্ষিপ্ত ঠিকানা"],
    ["last_donation_date", "সর্বশেষ রক্তদানের তারিখ"], ["location", "লোকেশন"],
    ["total_donations", "সর্বমোট রক্তদানের সংখ্যা"],
  ];
  const LOGIN_TIER_FIELDS = [
    ["donation_history_tab", "ডোনেশন হিষ্ট্রি ট্যাব"], ["call_history_tab", "কল হিষ্ট্রি ট্যাব"],
    ["eligibility_status", "বর্তমান এলিজিবিলিটি"],
  ];
  const NOTE_FIELD = ["note", "নোট"];
  const PATIENT_STATUSES = [["public", "পাবলিক"], ["login", "লগইন করা ইউজার"], ["patients_only", "শুধুমাত্র রোগী"], ["hidden", "হিডেন"]];
  const LOGIN_STATUSES = [["public", "পাবলিক"], ["login", "লগইন করা ইউজার"], ["hidden", "হিডেন"]];
  const NOTE_STATUSES = [["public", "পাবলিক"], ["login", "লগইন করা ইউজার"]];

  const card = h("div", { class: "card stack" });
  const selects = {};
  function addSelectField(key, label, statuses) {
    const sel = h("select");
    statuses.forEach(([v, l]) => sel.appendChild(h("option", { value: v, selected: profile.visibility[key] === v ? "" : null }, l)));
    selects[key] = sel;
    card.appendChild(h("div", { class: "field" }, [h("label", {}, label), sel]));
  }
  PATIENT_TIER_FIELDS.forEach(([k, l]) => addSelectField(k, l, PATIENT_STATUSES));
  LOGIN_TIER_FIELDS.forEach(([k, l]) => addSelectField(k, l, LOGIN_STATUSES));
  addSelectField(NOTE_FIELD[0], NOTE_FIELD[1], NOTE_STATUSES);

  const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ করুন");
  card.appendChild(saveBtn);
  view.appendChild(card);

  saveBtn.onclick = async () => {
    const visibility = {};
    Object.entries(selects).forEach(([k, s]) => (visibility[k] = s.value));
    try { await API.put("/api/profile/visibility", { visibility }); toast("সংরক্ষণ করা হয়েছে"); }
    catch (e) { toast(e.message); }
  };
};

// -------------------------------------------------------------------- CALLS
ViewsAccount.calls = async function (view) {
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "কল হিষ্ট্রি"));
  const body = h("div");
  view.appendChild(body);
  await renderProfileCallsTab(body, true);
};

// ----------------------------------------------------------------- SETTINGS
ViewsAccount.settings = async function (view) {
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "সেটিংস"));

  if (APP.user.mustChangePassword) {
    view.appendChild(h("div", { class: "banner banner-error" }, "প্রথমবার লগইন করেছেন - অনুগ্রহ করে পাসওয়ার্ড পরিবর্তন করুন।"));
  }

  const pwCard = h("div", { class: "card stack" });
  pwCard.appendChild(h("h3", {}, "পাসওয়ার্ড পরিবর্তন"));
  const oldPwWrap = passwordField("বর্তমান পাসওয়ার্ড");
  const newPwWrap = passwordField("নতুন পাসওয়ার্ড");
  const oldPw = oldPwWrap.querySelector("input");
  const newPw = newPwWrap.querySelector("input");
  pwCard.appendChild(h("div", { class: "field" }, [h("label", {}, "বর্তমান পাসওয়ার্ড"), oldPwWrap]));
  pwCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন পাসওয়ার্ড"), newPwWrap]));
  const pwBtn = h("button", { class: "btn btn-primary" }, "পরিবর্তন করুন");
  pwCard.appendChild(pwBtn);
  enterSubmits([oldPw, newPw], pwBtn);
  pwBtn.onclick = async () => {
    try {
      await API.post("/api/auth/change-password", { oldPassword: oldPw.value, newPassword: newPw.value });
      toast("পাসওয়ার্ড পরিবর্তন হয়েছে");
      APP.user.mustChangePassword = false;
      navigate("/profile");
    } catch (e) { toast(e.message); }
  };
  view.appendChild(pwCard);

  if (APP.user.isDonor) {
    const offCard = h("div", { class: "card stack" });
    offCard.appendChild(h("h3", {}, "ডোনার মোড"));
    const offBtn = h("button", { class: "btn btn-outline" }, "ডোনার মোড বন্ধ করুন");
    offCard.appendChild(offBtn);
    offBtn.onclick = async () => {
      const sure = await confirmModal("আপনি কি নিশ্চিতভাবে ডোনার মোড বন্ধ করতে চান?", { title: "ডোনার মোড বন্ধ" });
      if (!sure) return;
      try {
        await API.post("/api/donor/mode-off");
        APP.user.isDonor = false;
        toast("ডোনার মোড বন্ধ করা হয়েছে");
        navigate("/profile");
      } catch (e) { toast(e.message); }
    };
    view.appendChild(offCard);
  }

  const logoutCard = h("div", { class: "card" });
  logoutCard.appendChild(h("button", { class: "btn btn-outline", onclick: doLogout }, [icon("log-out", "small"), " লগআউট"]));
  view.appendChild(logoutCard);

  if ((APP.settings || {}).selfDeletionEnabled !== false) {
    const delCard = h("div", { class: "card stack" });
    delCard.appendChild(h("h3", {}, "প্রোফাইল ডিলেট"));
    delCard.appendChild(h("p", { class: "small muted" }, "নিশ্চিত করতে আপনার মোবাইল নাম্বার লিখুন। এই কাজটি স্থায়ী।"));
    const confirmField = h("input", { type: "tel", placeholder: "মোবাইল নাম্বার" });
    delCard.appendChild(h("div", { class: "field" }, confirmField));
    const delBtn = h("button", { class: "btn btn-danger" }, "প্রোফাইল ডিলেট করুন");
    delCard.appendChild(delBtn);
    enterSubmits(confirmField, delBtn);
    delBtn.onclick = async () => {
      const sure = await confirmModal("আপনি কি নিশ্চিতভাবে প্রোফাইল ডিলেট করতে চান? এই কাজটি স্থায়ী।", { title: "প্রোফাইল ডিলেট" });
      if (!sure) return;
      try {
        await API.post("/api/profile/delete", { mobileConfirm: confirmField.value.trim() });
        APP.user = null;
        toast("প্রোফাইল ডিলিট করা হয়েছে");
        navigate("/");
      } catch (e) { toast(e.message); }
    };
    view.appendChild(delCard);
  }
};
