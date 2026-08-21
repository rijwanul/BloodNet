const ViewsAccount = {};

// ------------------------------------------------------------------ QUICK
ViewsAccount.quick = async function (view) {
  const status = await API.get("/api/donor/status");
  const { eligibilityStatus, snoozeUntil, snoozeReason, note, lastEligibilityChangeNote, pendingDonationPrompt } = status;
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "আমার অবস্থা"));
  view.appendChild(h("p", { class: "muted small" }, [
    "রক্তদানের প্রস্তুতি সুইচ ও মোবাইল নাম্বার পরিবর্তন ব্যতিত প্রায় সকল বিষয় ",
    h("a", { href: "/profile/edit", "data-link": "" }, "প্রোফাইল"),
    " থেকেও আপডেট করা সম্ভব।",
  ]));

  // If the last call outcome was "রক্ত দিতে পারবে", the donation-entry
  // section moves to position 1 with an extra "না, সম্প্রতি রক্তদান করিনি"
  // escape hatch. Otherwise it stays in its normal position 3.
  const sections = { toggle: renderEligibilityToggleSection, note: renderNoteSection, donation: renderDonationPromptSection, mobile: renderMobileChangeSection, location: renderLocationChangeSection };
  const order = pendingDonationPrompt
    ? ["donation", "toggle", "note", "mobile", "location"]
    : ["toggle", "note", "donation", "mobile", "location"];

  if (lastEligibilityChangeNote) {
    const banner = h("div", { class: "banner banner--dismissible", style: "background:var(--surface-2);color:var(--ink-soft)" }, [
      h("span", {}, lastEligibilityChangeNote),
    ]);
    // Persists server-side now (previously DOM-only, so it reappeared on
    // every refresh even after being dismissed) - the DOM removal still
    // happens immediately for instant feedback, the API call runs
    // alongside it rather than blocking the visual dismissal.
    const dismissBtn = h("button", { type: "button", class: "banner__dismiss", "aria-label": "বন্ধ করুন", onclick: () => {
      banner.remove();
      API.post("/api/donor/dismiss-eligibility-note", {}).catch(() => {});
    } }, icon("x", "small"));
    banner.appendChild(dismissBtn);
    view.appendChild(banner);
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
  toggleRow.appendChild(h("div", {}, [h("b", {}, "রক্তদানের জন্য প্রস্তুত"), "\u00A0\u00A0", badge]));
  toggleRow.appendChild(switchWrap);
  card.appendChild(toggleRow);

  const snoozeArea = h("div", { style: "margin-top:12px" });
  card.appendChild(snoozeArea);
  view.appendChild(card);

  if (eligibilityStatus === "snoozed" && snoozeUntil) {
    snoozeArea.appendChild(renderCountdown(snoozeUntil, snoozeReason));
  }

  // Appended to the card AFTER snoozeArea, so it naturally sits at the
  // true bottom of the section regardless of whether snoozeArea ends up
  // holding a countdown/snooze-options block or nothing at all.
  const shareBase = (APP.settings && APP.settings.profileShareBaseUrl) || location.origin;
  const shareUrl = APP.user && APP.user.username ? `${shareBase.replace(/\/$/, "")}/${APP.user.username}` : null;
  const profileLinkSpan = h("a", { href: "#", onclick: (e) => {
    e.preventDefault();
    if (!shareUrl) return;
    copyToClipboard(shareUrl, "প্রোফাইল লিংক কপি হয়েছে");
  } }, "প্রোফাইল লিংক");
  card.appendChild(h("p", { class: "muted small", style: "margin-top:12px" }, [
    "সুইচটি বন্ধ রাখলে, রক্ত দরকার অপশনে রোগীর কাছে আপনার তথ্য প্রদান করা হবে না। তবে আপনি ম্যানুয়ালি আপনার ",
    profileLinkSpan,
    " শেয়ার করতে পারবেন।",
  ]));

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
  // Styled to match the dashed warn-colored callout the note gets on the
  // profile page (.donor-card__note) instead of a plain neutral .card -
  // uses that class alone (not combined with .card) since .card's own
  // background/border/padding would otherwise fight with it for the same
  // properties, depending on CSS source order.
  // Inline style, not a CSS-file change: .donor-card__note has no
  // box-shadow of its own (it was designed as an inline callout inside a
  // profile card, not a standalone floating card like the other /quick
  // sections use), so this adds the same shadow those sibling .card
  // elements get, scoped to just this one instance.
  const noteCard = h("div", { class: "stack donor-card__note", style: "box-shadow: var(--shadow);" });
  noteCard.appendChild(h("h3", {}, "নোট আপডেট"));
  const noteField = h("textarea", { placeholder: "যেমনঃ ২ ঘন্টা আগে জানাবেন" });
  noteField.value = status.note || "";
  noteCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন নোট"), noteField]));
  // Inline border override: .btn-outline's border-color (var(--line), a
  // light neutral gray meant to stand out against a plain white .card)
  // nearly disappears against .donor-card__note's warm tinted background -
  // var(--warn) matches the callout's own border color instead.
  const noteBtn = h("button", { class: "btn btn-outline", style: "border-color: var(--warn);" }, "আপডেট");
  noteField.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!noteBtn.disabled) noteBtn.click();
  }
});
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

// Compact inline countdown for a public-facing eligibility badge - unlike
// renderCountdown (which is a full reason+banner used on the donor's own
// snooze page), this returns just a small ticking text span suitable for
// sitting next to a badge. Same UTC "Z" fix applies (see renderCountdown).
function inlineCountdown(untilIso) {
  const span = h("span", { class: "small muted", style: "margin-left:6px" });
  const target = new Date(untilIso.replace(" ", "T") + "Z").getTime();
  const tick = () => {
    const diff = target - Date.now();
    if (diff <= 0) { span.textContent = "(শীঘ্রই সক্রিয় হবে)"; clearInterval(interval); return; }
    span.textContent = `(সক্রিয় হতে বাকি: ${bnDuration(Date.now(), target)})`;
  };
  tick();
  const interval = setInterval(tick, 1000);
  return span;
}

function renderCountdown(untilIso, reason) {
  const wrap = h("div", { class: "banner banner-error", style: "background:var(--warn-tint);color:var(--warn);border-color:var(--warn)" });
  const label = h("span", {});
  wrap.appendChild(h("div", {}, reason ? `কারণ: ${reason}` : ""));
  wrap.appendChild(label);
  // untilIso is stored as a UTC timestamp with no timezone marker (e.g.
  // "2026-08-19 14:30:00" from .toISOString().slice(0,19)). Without an
  // explicit "Z", the Date constructor parses a plain "T"-joined string as
  // LOCAL time instead of UTC - on a UTC+6 browser (Bangladesh) that skews
  // the countdown target by 6 hours, which is exactly why the ২ ঘন্টা/৬
  // ঘন্টা snooze options appeared to expire almost immediately instead of
  // waiting the stated duration. Appending "Z" tells it this is UTC.
  const target = new Date(untilIso.replace(" ", "T") + "Z").getTime();
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
    enforceDateBound(dateInput, todayIsoDate(), "min", "অতীতের তারিখ নির্বাচন করা যাবে না");
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

  const body = h("div", { class: "profile-tab-body" });
  view.appendChild(body);

  if (profile.isDonor) {
    view.appendChild(h("div", { class: "btn-row", style: "margin-top:16px" }, [
      h("a", { href: "/profile/edit", "data-link": "", class: "btn btn-primary" }, "এডিট প্রোফাইল"),
      h("a", { href: "/profile/privacy", "data-link": "", class: "btn btn-outline" }, "প্রাইভেসি সেটিংস"),
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
    // min-width:0 lets this flex child actually shrink below its content
    // width (flex items default to min-width:auto, which is what let the
    // URL push the row wider than its card on narrow screens); the link
    // itself truncates with an ellipsis instead of overflowing.
    const urlRow = h("div", { class: "row", style: "min-width:0" });
    urlRow.appendChild(h("b", { style: "flex-shrink:0" }, "প্রোফাইল URL: "));
    urlRow.appendChild(h("a", { href: shareUrl, style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, shareUrl));
    const copyBtn = h("button", { type: "button", class: "btn-icon", title: "কপি করুন", onclick: () => copyToClipboard(shareUrl, "লিংক কপি হয়েছে") }, icon("copy", "small"));
    const editBtn = h("button", { type: "button", class: "btn-icon", title: "ইউজারনেইম পরিবর্তন করুন", onclick: () => toggleUsernameEditor(card, profile) }, icon("pencil", "small"));
    urlRow.appendChild(copyBtn);
    urlRow.appendChild(editBtn);
    card.appendChild(urlRow);
    // Hidden by default - shown below the URL row when the pencil icon is
    // clicked (see toggleUsernameEditor), rather than appearing anywhere
    // else on the page.
    card.appendChild(h("div", { id: "usernameEditorSlot" }));
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
  // Fixed slot placed directly after the URL row (see renderInfoTab) - was
  // previously card.lastChild, which meant "wherever the card's rendering
  // happened to end", landing at the bottom of the whole info card below
  // address/donation-date/location/eligibility instead of right under the
  // URL row where the pencil icon that opens it actually lives.
  const wrap = card.querySelector("#usernameEditorSlot");
  if (wrap.style.display === "block") { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
  wrap.innerHTML = "";
  wrap.style.display = "block";
  const slugField = h("input", { type: "text", placeholder: "নতুন ইউজারনেইম" });
  const hint = h("div", { class: "field-hint" });
  const updateBtn = h("button", { class: "btn btn-sm btn-outline" }, "পরিবর্তন করুন");
  wrap.appendChild(h("div", { class: "field", style: "margin-top:10px" }, [h("label", {}, "নতুন ইউজারনেইম"), slugField, hint]));
  wrap.appendChild(updateBtn);
  enterSubmits(slugField, updateBtn);

  // Live availability feedback as the person types, debounced so it isn't
  // firing a request on every keystroke - matches the spec's example
  // phrasing exactly ("'rashed' ইউজারনেইমটি এভেইলেবল আছে").
  let checkTimer = null;
  let lastCheckedValue = null;
  slugField.addEventListener("input", () => {
    clearTimeout(checkTimer);
    const val = slugField.value.trim();
    if (!val) { hint.textContent = ""; hint.className = "field-hint"; return; }
    hint.textContent = "যাচাই করা হচ্ছে…";
    hint.className = "field-hint";
    checkTimer = setTimeout(async () => {
      if (slugField.value.trim() !== val) return; // stale - user kept typing
      try {
        const res = await API.get(`/api/profile/username/check?slug=${encodeURIComponent(val)}`);
        if (slugField.value.trim() !== val) return; // stale by the time the response arrived
        lastCheckedValue = val;
        if (res.available) {
          hint.textContent = `'${val}' ইউজারনেইমটি এভেইলেবল আছে।`;
          hint.className = "field-hint field-hint--ok";
        } else {
          hint.textContent = `'${val}' ইউজারনেইমটি এভেইলেবল নেই।`;
          hint.className = "field-error";
        }
      } catch {
        hint.textContent = "";
        hint.className = "field-hint";
      }
    }, 500);
  });

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
  // Backend already orders donation_date DESC, id DESC (NULLs/undated last
  // in SQLite's default ordering), so no re-sort needed here - dated
  // entries appear first, undated-but-remembered-hospital entries below
  // them with a dash standing in for the date.
  donations.forEach((d) => card.appendChild(renderDonationListItem(d, body, profile)));
  if (extraCount > 0) card.appendChild(h("p", { class: "muted small" }, `…এবং আরো ${toBnDigits(extraCount)} বার`));
  if (!donations.length && !extraCount) card.appendChild(h("p", { class: "muted" }, "কোনো তথ্য নেই"));
  body.appendChild(card);

  const addCard = h("div", { class: "card stack" });
  addCard.appendChild(h("h3", {}, "ডোনেশন তথ্য সংযোজন"));

  // Field/checkbox order per spec: তারিখ row (with মনে নেই to its right),
  // then হাসপাতালের নাম row (with its own মনে নেই to the right), then - only
  // once তারিখ is marked মনে নেই - the "আরো রয়েছে" follow-up beneath তারিখ,
  // which itself hides হাসপাতালের নাম while checked.
  const dateField = h("input", { type: "date", max: todayIsoDate() });
  enforceDateBound(dateField, todayIsoDate(), "max", "ভবিষ্যতের তারিখ নির্বাচন করা যাবে না");
  const dateUnknownCb = h("input", { type: "checkbox", id: "donDateUnknownCb" });
  addCard.appendChild(h("div", { class: "field-row-with-checkbox" }, [
    h("div", { class: "field", style: "flex:1" }, [h("label", {}, "তারিখ"), dateField]),
    h("label", { class: "checkbox-row checkbox-row--inline", for: "donDateUnknownCb" }, [dateUnknownCb, h("span", { class: "lbl" }, "মনে নেই")]),
  ]));

  const moreUnknownWrap = h("div", { style: "display:none" });
  const moreUnknownCb = h("input", { type: "checkbox", id: "donMoreUnknownCb" });
  moreUnknownWrap.appendChild(h("label", { class: "checkbox-row", for: "donMoreUnknownCb" }, [moreUnknownCb, h("span", { class: "lbl" }, "এমন মনে না থাকা ডোনেশন আরো রয়েছে")]));
  const totalUnknownWrap = h("div", { style: "display:none" });
  const totalUnknownField = h("input", { type: "number", min: "1" });
  totalUnknownWrap.appendChild(h("div", { class: "field" }, [h("label", {}, "এমন মনে না থাকা ডোনেশন এর সংখ্যা কত? (এটিসহ সর্বমোট):"), totalUnknownField]));
  moreUnknownWrap.appendChild(totalUnknownWrap);
  addCard.appendChild(moreUnknownWrap);

  const hospField = h("input", { type: "text", placeholder: "হাসপাতালের নাম" });
  const hospUnknownCb = h("input", { type: "checkbox", id: "donHospUnknownCb" });
  const hospRow = h("div", { class: "field-row-with-checkbox" }, [
    h("div", { class: "field", style: "flex:1" }, [h("label", {}, "হাসপাতালের নাম"), hospField]),
    h("label", { class: "checkbox-row checkbox-row--inline", for: "donHospUnknownCb" }, [hospUnknownCb, h("span", { class: "lbl" }, "মনে নেই")]),
  ]);
  addCard.appendChild(hospRow);

  dateField.disabled = false;
  const syncDateUnknown = () => {
    dateField.disabled = dateUnknownCb.checked;
    if (dateUnknownCb.checked) dateField.value = "";
    moreUnknownWrap.style.display = dateUnknownCb.checked ? "block" : "none";
    if (!dateUnknownCb.checked) { moreUnknownCb.checked = false; totalUnknownWrap.style.display = "none"; hospRow.style.display = ""; }
  };
  dateUnknownCb.onchange = syncDateUnknown;
  hospField.disabled = false;
  hospUnknownCb.onchange = () => { hospField.disabled = hospUnknownCb.checked; if (hospUnknownCb.checked) hospField.value = ""; };
  // "আরো রয়েছে" checked -> হাসপাতালের নাম row (which has no meaning once the
  // donor is describing a bucket of many undated donations) is hidden entirely.
  moreUnknownCb.onchange = () => {
    totalUnknownWrap.style.display = moreUnknownCb.checked ? "block" : "none";
    hospRow.style.display = moreUnknownCb.checked ? "none" : "";
  };

  const addBtn = h("button", { class: "btn btn-accent" }, "যোগ করুন");
  addCard.appendChild(addBtn);
  enterSubmits([dateField, hospField, totalUnknownField], addBtn);
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

// Single donation row with an edit/delete affordance. Undated-but-
// hospital-remembered entries show a dash in place of the date (backend
// already sorts these below dated entries).
function renderDonationListItem(d, body, profile) {
  const row = h("div", { class: "list-item" });
  const dateLabel = d.donation_date ? bnDate(d.donation_date) : "—";
  const textSpan = h("span", {}, [dateLabel, d.hospital_name ? h("span", { class: "muted" }, ` · ${d.hospital_name}`) : null]);
  row.appendChild(textSpan);

  const actions = h("div", { class: "list-item__actions" });
  const editBtn = h("button", { type: "button", class: "btn-icon", title: "সম্পাদনা করুন", onclick: () => toggleDonationEditor(row, d, body, profile) }, icon("pencil", "small"));
  const deleteBtn = h("button", { type: "button", class: "btn-icon", title: "ডিলিট করুন", onclick: async () => {
    if (!confirm("এই এন্ট্রিটি ডিলিট করতে চান?")) return;
    try {
      await API.del(`/api/profile/donations/${d.id}`);
      toast("ডিলিট করা হয়েছে");
      body.innerHTML = "";
      renderDonationsTab(body, profile);
    } catch (e) { toast(e.message); }
  } }, icon("trash-2", "small"));
  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  row.appendChild(actions);
  return row;
}

function toggleDonationEditor(row, d, body, profile) {
  const existing = row.querySelector(".donation-editor");
  if (existing) { existing.remove(); return; }
  const editor = h("div", { class: "donation-editor stack", style: "margin-top:10px;width:100%" });
  const dateField = h("input", { type: "date", max: todayIsoDate() });
  enforceDateBound(dateField, todayIsoDate(), "max", "ভবিষ্যতের তারিখ নির্বাচন করা যাবে না");
  if (d.donation_date) dateField.value = d.donation_date;
  const hospField = h("input", { type: "text", placeholder: "হাসপাতালের নাম" });
  if (d.hospital_name) hospField.value = d.hospital_name;
  editor.appendChild(h("div", { class: "field" }, [h("label", {}, "তারিখ"), dateField]));
  editor.appendChild(h("div", { class: "field" }, [h("label", {}, "হাসপাতালের নাম"), hospField]));
  const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ করুন");
  editor.appendChild(saveBtn);
  saveBtn.onclick = async () => {
    try {
      await API.put(`/api/profile/donations/${d.id}`, {
        date: dateField.value || null,
        dateUnknown: !dateField.value,
        hospitalName: hospField.value || null,
        hospitalUnknown: !hospField.value,
      });
      toast("পরিবর্তন সংরক্ষণ করা হয়েছে");
      body.innerHTML = "";
      renderDonationsTab(body, profile);
    } catch (e) { toast(e.message); }
  };
  row.appendChild(editor);
}

// Profile tab's own "calls" section - RECEIVED calls only, last 5, with
// aggregate counters above the list.
async function renderProfileCallsTab(body, isSelf) {
  const data = await API.get("/api/calls/received-summary");
  const summaryCard = h("div", { class: "card stack" });
  summaryCard.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল করেছেন: "), `${toBnDigits(data.totalCallsMade)} বার`]));
  summaryCard.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল ষ্ট্যাটাস আপডেট করেন নি: "), `${toBnDigits(data.totalNotUpdated)} বার`]));
  summaryCard.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল রিসিভ করেছেন: "), `${toBnDigits(data.totalCallsReceived)} বার`]));
  summaryCard.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল রিসিভ করেননি: "), `${toBnDigits(data.totalNotPickedUp)} বার`]));
  body.appendChild(summaryCard);

  const card = h("div", { class: "card" });
  if (!data.calls.length) {
    card.appendChild(h("p", { class: "muted" }, "কোনো কল হিষ্ট্রি নেই"));
  } else {
    card.appendChild(h("p", { class: "muted small" }, "সর্বশেষ ৫টি কল দেখানো হচ্ছে যা এই প্রোফাইল হোল্ডারকে করা হয়েছে।"));
    // Every row here is always "someone called the profile holder" (this
    // endpoint is received-only, see receivedCallsSummaryFor) - so unlike
    // the site-wide /calls page, there's no need to spell that out or
    // repeat the profile holder's own name in the status column, hence
    // the plain দুই-কলাম caller/status table instead of a full sentence.
    const table = h("table", { class: "activity-log-table profile-calls-table" });
    table.appendChild(h("thead", {}, h("tr", {}, [h("th", {}, "কল করেছিলো"), h("th", {}, "ষ্ট্যাটাস")])));
    const tbody = h("tbody");
    data.calls.forEach((c) => {
      tbody.appendChild(h("tr", {}, [
        h("td", {}, [personLink(c.requesterLabel, c.requesterSlug), h("div", { class: "small muted" }, bnDateTimeLong(c.createdAt))]),
        h("td", {}, c.statusPhrase),
      ]));
    });
    table.appendChild(tbody);
    card.appendChild(table);
  }
  body.appendChild(card);
}

// Site-wide /calls page - full history, both directions, newest first,
// with date+time and an "আপডেট করুন" action on entries never updated.
// Unlike the profile tab (always a third-party view of someone else's
// calls), this page is the signed-in person's OWN call history, so every
// row is rewritten from their perspective instead of reusing the
// third-party requester/donor sentence - see renderOwnCallHistoryRow.
async function renderFullCallHistory(body) {
  const { calls } = await API.get("/api/calls/history");
  const card = h("div", { class: "card stack" });
  if (!calls.length) card.appendChild(h("p", { class: "muted" }, "কোনো কল হিষ্ট্রি নেই"));
  calls.forEach((c) => card.appendChild(renderOwnCallHistoryRow(c, body)));
  body.appendChild(card);
}

// Rewrites a call row from the signed-in person's own point of view:
//  - They were the REQUESTER (they placed the call): own name/number
//    collapses to "আপনি", verb becomes করেছিলেন (matches আপনি
//    grammatically), and the other party's name is dropped from the
//    status clause since it was just named right before it.
//    "আপনি কল করেছিলেন X (মাস্কড) কে। ষ্ট্যাটাস: <phrase>"
//  - They were the DONOR (they received the call): restructured to lead
//    with "আপনাকে কল করেছিলো" + the caller's name/number, no "কে", and
//    the status clause becomes "ষ্ট্যাটাস জানিয়েছে:" since it's reporting
//    what was said about the signed-in person's own status, not someone
//    else's.
//    "আপনাকে কল করেছিলো X (মাস্কড)। ষ্ট্যাটাস জানিয়েছে: <phrase>"
function renderOwnCallHistoryRow(c, body) {
  const row = h("div", { class: "list-item list-item--stacked" });
  const isRequester = APP.user && c.requesterId === APP.user.id;
  let line;
  if (isRequester) {
    line = h("div", {}, [
      "আপনি কল করেছিলেন ",
      personLink(c.donorLabel, c.donorSlug),
      " কে। ষ্ট্যাটাস: " + c.statusPhrase,
    ]);
  } else {
    line = h("div", {}, [
      "আপনাকে কল করেছিলো ",
      personLink(c.requesterLabel, c.requesterSlug),
      "। ষ্ট্যাটাস জানিয়েছে: " + c.statusPhrase,
    ]);
  }
  row.appendChild(line);
  row.appendChild(h("div", { class: "small muted" }, bnDateTimeLong(c.createdAt)));
  if (c.status === "pending") {
    const updateBtn = h("button", { class: "btn btn-outline btn-sm", style: "margin-top:6px" }, "আপডেট করুন");
    updateBtn.onclick = () => renderInlineStatusUpdate(row, c, body);
    row.appendChild(updateBtn);
  }
  return row;
}

const CALL_STATUS_OPTIONS = [
  { key: "no_answer", label: "কল যাচ্ছে না" },
  { key: "not_picked_up", label: "কল ধরেনি" },
  { key: "cannot_donate", label: "রক্ত দিতে পারবে না" },
  { key: "can_donate", label: "রক্ত দিতে পারবে" },
];
const CALL_CANNOT_REASONS = [
  { key: "not_yet_eligible", label: "রক্ত দেওয়ার সময় হয়নি" },
  { key: "far_away", label: "দূরে আছেন" },
  { key: "busy_today", label: "আজকে ব্যস্ত" },
  { key: "no_reason_given", label: "কারণ জানান নি" },
];

function renderInlineStatusUpdate(row, c, body) {
  const existing = row.querySelector(".inline-status-update");
  if (existing) { existing.remove(); return; }
  const wrap = h("div", { class: "inline-status-update stack", style: "margin-top:8px" });
  CALL_STATUS_OPTIONS.forEach((opt) => {
    wrap.appendChild(h("button", { class: "btn btn-outline btn-sm", onclick: () => submitInlineStatus(wrap, c, opt.key, null, body) }, opt.label));
  });
  row.appendChild(wrap);
}

async function submitInlineStatus(wrap, c, status, cannotReason, body) {
  if (status === "cannot_donate" && !cannotReason) {
    wrap.innerHTML = "";
    CALL_CANNOT_REASONS.forEach((r) => {
      wrap.appendChild(h("button", { class: "btn btn-outline btn-sm", onclick: () => submitInlineStatus(wrap, c, status, r.key, body) }, r.label));
    });
    return;
  }
  try {
    await API.post("/api/seek/call-status", { callId: c.id, status, cannotReason });
    toast("ষ্ট্যাটাস সংরক্ষণ করা হয়েছে");
    body.innerHTML = "";
    renderFullCallHistory(body);
  } catch (e) { toast(e.message); }
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
  const picRemoveBtn = h("button", { type: "button", class: "btn-icon", title: "ছবি সরান", style: profile.profilePicUrl ? "" : "display:none" }, icon("trash-2", "small"));
  card.appendChild(h("div", { class: "center" }, [picPreview, picInput, picRemoveBtn]));
  let picBase64 = null;
  let removePic = false;
  picInput.onchange = async () => {
    if (picInput.files[0]) {
      // Downscale/compress client-side before it ever becomes base64 -
      // otherwise a full-resolution phone photo (often several MB) can
      // exceed the request size the Worker will accept, which previously
      // failed completely silently (see readJson's fix in util.js) and
      // looked exactly like "the image isn't uploading" with no visible
      // cause. Capping the longest side at 800px keeps a profile picture
      // plenty sharp while keeping the payload small and reliable.
      picBase64 = await downscaleImageToBase64(picInput.files[0], 800);
      picPreview.src = "data:image/jpeg;base64," + picBase64;
      removePic = false;
      picRemoveBtn.style.display = "";
    }
  };
  picRemoveBtn.onclick = () => {
    removePic = true;
    picBase64 = null;
    picInput.value = "";
    picPreview.src = pickDefaultAvatar();
    picRemoveBtn.style.display = "none";
  };

  const nameField = h("input", { type: "text" }); nameField.value = profile.name || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "নাম"), nameField]));

  let bloodGroup = profile.bloodGroup;
  if (profile.isDonor) card.appendChild(h("div", { class: "field" }, [h("label", {}, "রক্তের গ্রুপ"), bloodGroupGrid(bloodGroup, (g) => (bloodGroup = g))]));

  const dateField = h("input", { type: "date", max: todayIsoDate() }); dateField.value = profile.lastDonationDate || "";
  enforceDateBound(dateField, todayIsoDate(), "max", "ভবিষ্যতের তারিখ নির্বাচন করা যাবে না");
  if (profile.isDonor) card.appendChild(h("div", { class: "field" }, [h("label", {}, "সর্বশেষ রক্তদানের তারিখ"), dateField]));

  const locSelect = h("select");
  await locationOptions(locSelect, profile.locationId);
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "এলাকা"), locSelect]));

  const addrField = h("input", { type: "text" }); addrField.value = profile.addressSummary || "";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "সংক্ষিপ্ত ঠিকানা"), addrField]));

  // Note is allowed to be empty - saving a blank note is an explicit choice, not an error.
  const noteField = h("textarea", { placeholder: "খালি রাখতে পারেন" }); noteField.value = profile.note || "";
  if (profile.isDonor) card.appendChild(h("div", { class: "field" }, [h("label", {}, "নোট"), noteField]));

  // Public profile layout preference - tab view (default) shows one
  // section at a time behind a tab strip; list view stacks every section
  // as its own card, one below another.
  const viewSelect = h("select");
  viewSelect.appendChild(h("option", { value: "tabs" }, "ট্যাব ভিউ"));
  viewSelect.appendChild(h("option", { value: "list" }, "লিষ্ট ভিউ"));
  viewSelect.value = profile.publicProfileView || "tabs";
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "পাবলিক প্রোফাইলের লেআউট"), viewSelect]));

  const saveBtn = h("button", { class: "btn btn-primary" }, "সংরক্ষণ করুন");
  card.appendChild(saveBtn);
  view.appendChild(card);

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const payload = { name: nameField.value, addressSummary: addrField.value, locationId: locSelect.value || null, publicProfileView: viewSelect.value };
      if (profile.isDonor) { payload.bloodGroup = bloodGroup; payload.lastDonationDate = dateField.value || null; payload.note = noteField.value; }
      if (picBase64) { payload.profilePicBase64 = picBase64; payload.profilePicFileName = picInput.files[0] ? picInput.files[0].name : undefined; }
      if (removePic) payload.removeProfilePic = true;
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
  const headerRow = h("div", { class: "row", style: "justify-content:space-between;align-items:center" });
  headerRow.appendChild(h("h2", {}, "প্রোফাইল তথ্যের গোপনীয়তা সেটিংস"));
  const resetBtn = h("button", { class: "btn btn-outline btn-sm" }, "ডিফল্টে রিসেট করুন");
  headerRow.appendChild(resetBtn);
  view.appendChild(headerRow);
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

  // Applies immediately (not just staged in the form) - re-fetches the
  // saved defaults and re-renders the whole page so the selects visibly
  // reflect the reset right away, matching "will change all fields to the
  // default settings and will apply those settings immediately".
  resetBtn.onclick = async () => {
    if (!confirm("গোপনীয়তা সেটিংস ডিফল্টে রিসেট করতে চান?")) return;
    try {
      await API.put("/api/profile/visibility", { reset: true });
      toast("ডিফল্টে রিসেট করা হয়েছে");
      ViewsAccount.profilePrivacy(view);
    } catch (e) { toast(e.message); }
  };
};

// -------------------------------------------------------------------- CALLS
ViewsAccount.calls = async function (view) {
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "কল হিষ্ট্রি"));
  const body = h("div");
  view.appendChild(body);
  await renderFullCallHistory(body);
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
  const confirmPwWrap = passwordField("নতুন পাসওয়ার্ড আবার লিখুন");
  const oldPw = oldPwWrap.querySelector("input");
  const newPw = newPwWrap.querySelector("input");
  const confirmPw = confirmPwWrap.querySelector("input");
  const pwErr = h("div", { class: "field-error" });
  pwCard.appendChild(h("div", { class: "field" }, [h("label", {}, "বর্তমান পাসওয়ার্ড"), oldPwWrap]));
  pwCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন পাসওয়ার্ড"), newPwWrap]));
  pwCard.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন পাসওয়ার্ড আবার লিখুন"), confirmPwWrap, pwErr]));
  const pwBtn = h("button", { class: "btn btn-primary" }, "পরিবর্তন করুন");
  pwCard.appendChild(pwBtn);
  enterSubmits([oldPw, newPw, confirmPw], pwBtn);
  pwBtn.onclick = async () => {
    pwErr.textContent = "";
    if (newPw.value !== confirmPw.value) { pwErr.textContent = "পাসওয়ার্ড দুটি মিলছে না"; return; }
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

  const logoutCard = h("div", { class: "card" });
  logoutCard.appendChild(h("button", { class: "btn btn-outline", onclick: doLogout }, [icon("log-out", "small"), " লগআউট"]));
  view.appendChild(logoutCard);

};
