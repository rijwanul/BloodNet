const ViewsAccount = {};

// ------------------------------------------------------------------ QUICK
ViewsAccount.quick = async function (view) {
  const { eligibilityStatus, snoozeUntil, snoozeReason, note, lastDonationDate } = await API.get("/api/donor/status");
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "আমার অবস্থা"));

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

  // নোট আপডেট
  const noteCard = h("div", { class: "card stack" });
  noteCard.appendChild(h("h3", {}, "নোট আপডেট"));
  const noteField = h("textarea", { placeholder: "যেমনঃ ২ ঘন্টা আগে জানাবেন" });
  noteField.value = note || "";
  noteCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন নোট"), noteField]));
  const noteBtn = h("button", { class: "btn btn-outline" }, "আপডেট");
  noteCard.appendChild(noteBtn);
  noteBtn.onclick = async () => {
    try { await API.post("/api/donor/note", { note: noteField.value }); toast("নোট আপডেট হয়েছে"); }
    catch (e) { toast(e.message); }
  };
  view.appendChild(noteCard);

  // রক্তদান করেছেন?
  const donCard = h("div", { class: "card stack" });
  donCard.appendChild(h("h3", {}, "রক্তদান করেছেন?"));
  const hospField = h("input", { type: "text", placeholder: "ঐচ্ছিক" });
  const dateField = h("input", { type: "date" });
  dateField.value = new Date().toISOString().slice(0, 10);
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
  view.appendChild(donCard);

  // মোবাইল নাম্বার পরিবর্তন
  const mobCard = h("div", { class: "card stack" });
  mobCard.appendChild(h("h3", {}, "মোবাইল নাম্বার পরিবর্তন"));
  const newMobField = h("input", { type: "tel", maxlength: "11", placeholder: "নতুন মোবাইল নাম্বার" });
  const otpField = h("input", { type: "text", maxlength: "6", placeholder: "ওটিপি কোড" });
  const sendOtpBtn = h("button", { class: "btn-sm btn btn-outline" }, "OTP পাঠান");
  mobCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন মোবাইল নাম্বার"), h("div", { class: "row" }, [newMobField, sendOtpBtn])]));
  mobCard.appendChild(h("div", { class: "field" }, [h("label", {}, "ওটিপি কোড"), otpField]));
  const mobBtn = h("button", { class: "btn btn-outline" }, "আপডেট");
  mobCard.appendChild(mobBtn);
  sendOtpBtn.onclick = async () => {
    if (!/^01[3-9]\d{8}$/.test(newMobField.value)) return toast("সঠিক মোবাইল নাম্বার দিন");
    try { await API.post("/api/otp/send", { mobile: newMobField.value, purpose: "change_mobile" }); toast("OTP পাঠানো হয়েছে"); }
    catch (e) { toast(e.message); }
  };
  mobBtn.onclick = async () => {
    try {
      await API.post("/api/donor/change-mobile", { newMobile: newMobField.value, otp: otpField.value });
      toast("মোবাইল নাম্বার পরিবর্তন হয়েছে");
    } catch (e) { toast(e.message); }
  };
  view.appendChild(mobCard);

  // এলাকা পরিবর্তন
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
};

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
    const h_ = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
    label.textContent = `স্বয়ংক্রিয়ভাবে চালু হতে বাকি: ${h_}ঘ ${m}মি ${s}সে`;
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
    const dateInput = h("input", { type: "date" });
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
  head.appendChild(h("img", { class: "donor-card__pic", src: profile.profilePicUrl || "/img/logo.png", alt: "" }));
  head.appendChild(h("div", { class: "donor-card__name" }, profile.name || profile.mobile));
  if (profile.isDonor) {
    const meta = profile.totalDonations > 0 ? `${profile.bloodGroup} (${profile.totalDonations} বার রক্তদান)` : (profile.bloodGroup || "");
    head.appendChild(h("div", { class: "donor-card__meta" }, meta));
  }
  if (profile.note) head.appendChild(h("div", { class: "donor-card__note" }, `নোট: ${profile.note}`));
  view.appendChild(head);

  const tabs = h("div", { class: "tabs" });
  const tabBtns = {
    info: h("button", { class: "active" }, "ডোনারের তথ্য"),
    donations: h("button", {}, "পূর্বের ডোনেশনসমূহ"),
    calls: h("button", {}, "কল হিষ্ট্রি"),
    other: h("button", {}, "অন্যান্য"),
  };
  Object.values(tabBtns).forEach((b) => tabs.appendChild(b));
  view.appendChild(tabs);

  const body = h("div");
  view.appendChild(body);

  view.appendChild(h("div", { class: "btn-row", style: "margin-top:16px" }, [
    h("a", { href: "/profile/edit", "data-link": "", class: "btn btn-primary" }, "এডিট প্রোফাইল"),
    h("a", { href: "/profile/privacy", "data-link": "", class: "btn btn-outline" }, "গোপনীয়তা সেটিংস"),
  ]));

  function setTab(key) {
    Object.entries(tabBtns).forEach(([k, b]) => b.classList.toggle("active", k === key));
    body.innerHTML = "";
    if (key === "info") renderInfoTab(body, profile);
    if (key === "donations") renderDonationsTab(body);
    if (key === "calls") renderProfileCallsTab(body, true);
    if (key === "other") renderOtherTab(body, profile);
  }
  tabBtns.info.onclick = () => setTab("info");
  tabBtns.donations.onclick = () => setTab("donations");
  tabBtns.calls.onclick = () => setTab("calls");
  tabBtns.other.onclick = () => setTab("other");
  setTab("info");
};

function renderInfoTab(body, profile) {
  const card = h("div", { class: "card stack" });
  const shareUrl = profile.username ? `${location.origin}/${profile.username}` : `${location.origin}/profile`;
  card.appendChild(h("div", {}, [h("b", {}, "প্রোফাইল URL: "), h("a", { href: shareUrl }, shareUrl)]));
  card.appendChild(h("button", { class: "btn btn-sm btn-outline", onclick: () => { navigator.clipboard?.writeText(shareUrl); toast("লিংক কপি হয়েছে"); } }, "শেয়ার লিংক কপি করুন"));
  if (profile.addressSummary) card.appendChild(h("div", {}, [h("b", {}, "সংক্ষিপ্ত ঠিকানা: "), profile.addressSummary]));
  if (profile.lastDonationDate) card.appendChild(h("div", {}, [h("b", {}, "সর্বশেষ রক্তদান: "), bnDate(profile.lastDonationDate)]));
  if (profile.locationName) card.appendChild(h("div", {}, [h("b", {}, "লোকেশন: "), profile.locationName]));
  card.appendChild(h("div", {}, [h("b", {}, "মোবাইল: "), profile.mobile]));
  body.appendChild(card);

  if (!profile.username) {
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
  } else {
    const updateCard = h("div", { class: "card stack" });
    updateCard.appendChild(h("h3", {}, "ইউজারনেইম পরিবর্তন করুন"));
    updateCard.appendChild(h("p", { class: "small muted" }, `বর্তমান: ${profile.username}`));
    const slugField = h("input", { type: "text", placeholder: "নতুন ইউজারনেইম" });
    const hint = h("div", { class: "field-hint" });
    const updateBtn = h("button", { class: "btn btn-outline" }, "পরিবর্তন করুন");
    updateCard.appendChild(h("div", { class: "field" }, [slugField, hint]));
    updateCard.appendChild(updateBtn);
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
    body.appendChild(updateCard);
  }
}

async function renderDonationsTab(body) {
  const { donations, extraCount } = await API.get("/api/profile/donations");
  const card = h("div", { class: "card stack" });
  const visible = donations.slice(0, 2);
  visible.forEach((d) => card.appendChild(h("div", { class: "list-item" }, [
    h("span", {}, bnDate(d.donation_date)), h("span", { class: "muted" }, d.hospital_name || ""),
  ])));
  donations.slice(2).forEach((d) => card.appendChild(h("div", { class: "list-item" }, [
    h("span", {}, bnDate(d.donation_date)), h("span", { class: "muted" }, d.hospital_name || ""),
  ])));
  if (extraCount > 0) card.appendChild(h("p", { class: "muted small" }, `…এবং আরো ${extraCount} বার`));
  if (!donations.length && !extraCount) card.appendChild(h("p", { class: "muted" }, "কোনো তথ্য নেই"));
  body.appendChild(card);

  const addCard = h("div", { class: "card stack" });
  addCard.appendChild(h("h3", {}, "ডোনেশন তথ্য সংযোজন"));
  const dateField = h("input", { type: "date" });
  const hospField = h("input", { type: "text", placeholder: "হাসপাতালের নাম" });
  const extraCb = h("input", { type: "checkbox" });
  addCard.appendChild(h("div", { class: "field" }, [h("label", {}, "তারিখ"), dateField]));
  addCard.appendChild(h("div", { class: "field" }, [h("label", {}, "হাসপাতালের নাম"), hospField]));
  addCard.appendChild(h("div", { class: "checkbox-row" }, [extraCb, h("span", { class: "lbl" }, "অতিরিক্ত ডোনেশন হিসেবে গণনা করুন")]));
  const addBtn = h("button", { class: "btn btn-accent" }, "যোগ করুন");
  addCard.appendChild(addBtn);
  addBtn.onclick = async () => {
    if (!dateField.value) return toast("তারিখ দিন");
    try {
      await API.post("/api/profile/donations", { date: dateField.value, hospitalName: hospField.value || null, countAsAdditionalExtra: extraCb.checked });
      toast("যোগ করা হয়েছে");
      body.innerHTML = "";
      renderDonationsTab(body);
    } catch (e) { toast(e.message); }
  };
  body.appendChild(addCard);

  const bulkCard = h("div", { class: "card stack" });
  bulkCard.appendChild(h("h3", {}, "মোট সংখ্যা পরিবর্তন (হাসপাতাল/তারিখ ছাড়া)"));
  const numField = h("input", { type: "number", min: "0", value: String(extraCount) });
  bulkCard.appendChild(h("div", { class: "field" }, [h("label", {}, "সংখ্যা"), numField]));
  const bulkBtn = h("button", { class: "btn btn-outline" }, "সংরক্ষণ করুন");
  bulkCard.appendChild(bulkBtn);
  bulkBtn.onclick = async () => {
    try { await API.post("/api/profile/donations/bulk", { count: parseInt(numField.value, 10) || 0 }); toast("আপডেট হয়েছে"); }
    catch (e) { toast(e.message); }
  };
  body.appendChild(bulkCard);
}

async function renderProfileCallsTab(body, isSelf) {
  const { received, made } = await API.get("/api/calls/history");
  const card = h("div", { class: "card stack" });
  if (!received.length && !made.length) card.appendChild(h("p", { class: "muted" }, "কোনো কল হিষ্ট্রি নেই"));
  [...received, ...made].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).forEach((c) => {
    card.appendChild(h("div", { class: "list-item" }, h("span", {}, c.text)));
  });
  body.appendChild(card);
}

function renderOtherTab(body, profile) {
  const card = h("div", { class: "card stack" });
  card.appendChild(h("div", {}, [h("b", {}, "প্ল্যাটফর্মে জয়েন করেছেন: "), bnDate(profile.createdAt)]));
  card.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল করেছেন: "), String(profile.totalCallsMade)]));
  if (profile.donorsManagedCount > 0) card.appendChild(h("div", {}, [h("b", {}, "রক্তদাতা পেয়েছেন: "), `${profile.donorsManagedCount} বার`]));
  if (profile.isDonor) card.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল রিসিভ করেছেন: "), String(profile.totalCallsReceived)]));
  if (profile.locationName) card.appendChild(h("div", {}, [h("b", {}, "লোকেশন: "), profile.locationName]));
  body.appendChild(card);
  if (!profile.isDonor) {
    const becomeCard = h("div", { class: "card center stack" });
    becomeCard.appendChild(h("p", {}, "আপনি কি রক্তদাতা হতে চান?"));
    becomeCard.appendChild(h("a", { href: "/join", "data-link": "", class: "btn btn-accent" }, "ডোনার হোন"));
    body.appendChild(becomeCard);
  }
}

// ------------------------------------------------------------ PROFILE EDIT
ViewsAccount.profileEdit = async function (view) {
  const { profile } = await API.get("/api/profile/me");
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "এডিট প্রোফাইল"));
  const card = h("div", { class: "card stack" });

  const picPreview = h("img", { class: "donor-card__pic", src: profile.profilePicUrl || "/img/logo.png", alt: "", style: "margin:0 0 10px" });
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

  const dateField = h("input", { type: "date" }); dateField.value = profile.lastDonationDate || "";
  if (profile.isDonor) card.appendChild(h("div", { class: "field" }, [h("label", {}, "সর্বশেষ রক্তদানের তারিখ"), dateField]));

  const locSelect = h("select");
  await locationOptions(locSelect, profile.locationId);
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "এলাকা"), locSelect]));

  const addrField = h("input", { type: "text" }); addrField.value = profile.addressSummary || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "সংক্ষিপ্ত ঠিকানা"), addrField]));

  const noteField = h("textarea", {}); noteField.value = profile.note || "";
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
  view.appendChild(h("p", { class: "muted small" }, "নাম, ইউজারনেইম, নোট সবসময় পাবলিক থাকবে।"));

  const FIELDS = [
    ["mobile", "মোবাইল নাম্বার"], ["address_summary", "সংক্ষিপ্ত ঠিকানা"], ["location", "লোকেশন"],
    ["last_donation_date", "সর্বশেষ রক্তদানের তারিখ"], ["total_donations", "সর্বমোট রক্তদানের সংখ্যা"],
    ["donation_history_tab", "ডোনেশন হিষ্ট্রি ট্যাব"], ["call_history_tab", "কল হিষ্ট্রি ট্যাব"],
  ];
  const STATUSES = [["public", "পাবলিক"], ["patients_only", "শুধুমাত্র রোগী"], ["hidden", "হিডেন"]];

  const card = h("div", { class: "card stack" });
  const selects = {};
  FIELDS.forEach(([key, label]) => {
    const sel = h("select");
    STATUSES.forEach(([v, l]) => sel.appendChild(h("option", { value: v, selected: profile.visibility[key] === v ? "" : null }, l)));
    selects[key] = sel;
    card.appendChild(h("div", { class: "field" }, [h("label", {}, label), sel]));
  });
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
