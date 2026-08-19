const ViewsPublic = {};

// ---------------------------------------------------------------- LANDING
ViewsPublic.landing = function (view) {
  const s = APP.settings || {};
  if (APP.user && APP.user.isDonor) return navigate("/quick");
  view.innerHTML = "";
  view.appendChild(h("div", { class: "hero" }, [
    h("h1", {}, s.welcomeHeading || "রক্তের প্রয়োজনে আমরা পাশে"),
    h("p", { class: "subhead" }, s.welcomeSubheading || "রক্তের প্রয়োজনে খুঁজে নিন ডোনারদের"),
    h("p", { class: "fineprint" }, s.welcomeSmallText || ""),
  ]));
  const cardDefs = [];
  if (s.showSeekOption !== false) {
    cardDefs.push(h("a", { href: "/seek", "data-link": "", class: "choice-card choice-card--seek" }, [
      icon("hand-heart", "icon"), h("b", {}, "রক্ত দরকার"), h("span", { class: "muted" }, "রক্তদাতা খুঁজুন এখনই"),
    ]));
  }
  if (s.showJoinOption !== false) {
    cardDefs.push(h("a", { href: "/join", "data-link": "", class: "choice-card choice-card--donate" }, [
      icon("droplets", "icon"), h("b", {}, "রক্ত দিতে প্রস্তুত"), h("span", { class: "muted" }, "ডোনার হিসেবে যুক্ত হোন"),
    ]));
  }
  view.appendChild(h("div", { class: "choice-cards" }, cardDefs));
  view.appendChild(pulseDivider());
  view.appendChild(h("p", { class: "center small" }, [
    !APP.user ? h("a", { href: "/login", "data-link": "" }, "লগইন") : h("span", { class: "muted" }, `স্বাগতম, ${APP.user.name || APP.user.mobile}`),
  ]));
};

// ------------------------------------------------------------ ACCOUNT GATE
// Shared mobile -> (password | OTP+new password) flow used by both /seek
// (as a requester) and /join (as a donor). Calls onDone() once logged in.
// If the person is ALREADY logged in, this is skipped entirely by callers -
// see ViewsPublic.seek/join below - so this function only ever runs for
// anonymous visitors.
function renderAccountGate(container, { intro, onDone }) {
  container.innerHTML = "";
  const card = h("div", { class: "card stack" });
  if (intro) card.appendChild(h("p", {}, intro));

  const mobileField = h("input", { type: "tel", inputmode: "numeric", maxlength: "11", placeholder: "01XXXXXXXXX" });
  const mobileErr = h("div", { class: "field-error" });
  const continueBtn = h("button", { class: "btn btn-primary" }, "এগিয়ে যান");
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "আপনার মোবাইল নাম্বার প্রদান করুন"), mobileField, mobileErr]));
  card.appendChild(continueBtn);
  container.appendChild(card);
  enterSubmits(mobileField, continueBtn);
  mobileField.focus();

  continueBtn.onclick = async () => {
    const mobile = mobileField.value.trim();
    if (!/^01[3-9]\d{8}$/.test(mobile)) { mobileErr.textContent = "সঠিক মোবাইল নাম্বার দিন"; return; }
    mobileErr.textContent = "";
    continueBtn.disabled = true;
    try {
      const { exists } = await API.get(`/api/auth/check-mobile?mobile=${mobile}`);
      if (exists) renderPasswordStep(container, mobile, onDone, () => renderAccountGate(container, { intro, onDone }));
      else await renderOtpStep(container, mobile, "register", onDone, () => renderAccountGate(container, { intro, onDone }));
    } catch (e) { toast(e.message); } finally { continueBtn.disabled = false; }
  };
}

function backRow(onBack) {
  const btn = h("button", { class: "back-btn", type: "button" }, [icon("chevron-left"), "পূর্ববর্তী ধাপ"]);
  btn.onclick = onBack;
  return h("div", { class: "back-row" }, btn);
}

function renderPasswordStep(container, mobile, onDone, onBack) {
  container.innerHTML = "";
  container.appendChild(backRow(onBack));
  const card = h("div", { class: "card stack" });
  const pwWrap = passwordField("পাসওয়ার্ড");
  const pwField = pwWrap.querySelector("input");
  const errBox = h("div", { class: "field-error" });
  const loginBtn = h("button", { class: "btn btn-primary" }, "লগইন");
  const forgotLink = h("a", { href: "#" }, "পাসওয়ার্ড ভুলে গিয়েছি");
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "পাসওয়ার্ড"), pwWrap, errBox]));
  card.appendChild(loginBtn);
  card.appendChild(h("p", { class: "center small", style: "margin-top:10px" }, forgotLink));
  container.appendChild(card);
  enterSubmits(pwField, loginBtn);
  pwField.focus();

  loginBtn.onclick = async () => {
    errBox.textContent = "";
    loginBtn.disabled = true;
    try {
      const { user } = await API.post("/api/auth/login", { mobile, password: pwField.value });
      APP.user = user;
      renderTopbar();
      onDone(user);
    } catch (e) { errBox.textContent = e.message; } finally { loginBtn.disabled = false; }
  };
  // Going to "forgot password" by mistake shouldn't strand the person there -
  // they can return to this same password step for the same mobile number.
  forgotLink.onclick = (e) => {
    e.preventDefault();
    renderOtpStep(container, mobile, "reset", onDone, () => renderPasswordStep(container, mobile, onDone, onBack));
  };
}

async function renderOtpStep(container, mobile, purpose, onDone, onBack) {
  container.innerHTML = "";
  container.appendChild(backRow(onBack));
  try {
    await API.post("/api/otp/send", { mobile, purpose });
    toast("OTP পাঠানো হয়েছে");
  } catch (e) { toast(e.message); }

  const card = h("div", { class: "card stack" });
  const otpField = h("input", { type: "text", inputmode: "numeric", maxlength: "6", placeholder: "৬ সংখ্যার OTP" });
  const pwWrap = passwordField("আপনার ইচ্ছেমতো নতুন পাসওয়ার্ড");
  const pwField = pwWrap.querySelector("input");
  const confirmWrap = passwordField("পাসওয়ার্ড আবার লিখুন");
  const confirmField = confirmWrap.querySelector("input");
  const errBox = h("div", { class: "field-error" });
  const submitBtn = h("button", { class: "btn btn-primary" }, purpose === "reset" ? "পাসওয়ার্ড রিসেট করুন" : "নিশ্চিত করুন");
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "ওটিপি কোড"), otpField]));
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "আপনার ইচ্ছেমতো নতুন পাসওয়ার্ড"), pwWrap]));
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "পাসওয়ার্ড নিশ্চিত করুন"), confirmWrap, errBox]));
  card.appendChild(submitBtn);
  container.appendChild(card);
  enterSubmits([otpField, pwField, confirmField], submitBtn);
  otpField.focus();

  submitBtn.onclick = async () => {
    errBox.textContent = "";
    if (pwField.value !== confirmField.value) { errBox.textContent = "পাসওয়ার্ড দুটি মিলছে না"; return; }
    submitBtn.disabled = true;
    try {
      if (purpose === "reset") {
        await API.post("/api/auth/forgot-password", { mobile, otp: otpField.value, newPassword: pwField.value });
        const { user } = await API.post("/api/auth/login", { mobile, password: pwField.value });
        APP.user = user; renderTopbar(); onDone(user);
      } else {
        const { user } = await API.post("/api/auth/register", { mobile, password: pwField.value, otp: otpField.value });
        APP.user = user; renderTopbar(); onDone(user);
      }
    } catch (e) { errBox.textContent = e.message; } finally { submitBtn.disabled = false; }
  };
}

// ----------------------------------------------------------------- LOGIN
ViewsPublic.login = function (view) {
  if (APP.user) return navigate(APP.user.isDonor ? "/quick" : "/profile");
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "লগইন"));
  const box = h("div");
  view.appendChild(box);
  renderAccountGate(box, { onDone: () => navigate(APP.user.isDonor ? "/quick" : "/profile") });
  view.appendChild(h("p", { class: "muted small center", style: "margin-top:18px" }, [
    "একাউন্ট নেই? ", h("a", { href: "/seek", "data-link": "" }, "রক্ত দরকার"), " অথবা ",
    h("a", { href: "/join", "data-link": "" }, "রক্ত দিতে প্রস্তুত"), " থেকে শুরু করুন।",
  ]));
};

ViewsPublic.forgotPassword = function (view) {
  view.innerHTML = "";
  view.appendChild(h("h2", {}, "পাসওয়ার্ড রিসেট"));
  const box = h("div");
  view.appendChild(box);
  const mobileField = h("input", { type: "tel", maxlength: "11", placeholder: "01XXXXXXXXX" });
  const btn = h("button", { class: "btn btn-primary" }, "OTP পাঠান");
  box.appendChild(h("div", { class: "card stack" }, [
    h("div", { class: "field" }, [h("label", {}, "মোবাইল নাম্বার"), mobileField]), btn,
  ]));
  enterSubmits(mobileField, btn);
  btn.onclick = () => renderOtpStep(box, mobileField.value.trim(), "reset", () => navigate("/profile"), () => ViewsPublic.forgotPassword(view));
};

// ------------------------------------------------------------------ SEEK
// Bookmarkable and refresh-safe: on mount, if the requester is logged in
// and already has an active donor lock (from before a refresh), jump
// straight back to that donor card instead of re-asking for a blood group.
ViewsPublic.seek = async function (view) {
  view.innerHTML = "";

  if (APP.user) {
    try {
      const state = await API.get("/api/seek/state");
      if (state.active && state.donor) {
        const box = h("div");
        view.appendChild(box);
        renderDonorCard(box, state.donor, state.bloodGroup);
        return;
      }
    } catch { /* fall through to normal flow */ }
  }

  renderBloodGroupStep(view);
};

function renderBloodGroupStep(view) {
  view.innerHTML = "";
  let selectedGroup = null;

  const groupCard = h("div", { class: "card stack" });
  groupCard.appendChild(h("h2", {}, "কোন গ্রুপের রক্ত প্রয়োজন?"));
  const countLine = h("p", { class: "muted" });
  const groupErr = h("div", { class: "field-error" });
  const continueBtn = h("button", { class: "btn btn-primary", style: "display:none" }, "এগিয়ে যান");

  const grid = bloodGroupGrid(null, async (g) => {
    selectedGroup = g;
    groupErr.textContent = "";
    countLine.textContent = "লোড হচ্ছে…";
    try {
      const { count } = await API.get(`/api/seek/count?bloodGroup=${encodeURIComponent(g)}`);
      countLine.textContent = `${toBnDigits(count)} জন উপযুক্ত রক্তদাতা রয়েছেন।`;
      continueBtn.style.display = "block";
    } catch (e) { countLine.textContent = ""; toast(e.message); }
  });
  groupCard.appendChild(grid);
  groupCard.appendChild(countLine);
  groupCard.appendChild(groupErr);
  groupCard.appendChild(continueBtn);
  view.appendChild(groupCard);

  // A blood group must be selected before proceeding - enforced here
  // regardless of login state, not only after the login gate.
  continueBtn.onclick = () => {
    if (!selectedGroup) { groupErr.textContent = "রক্তের গ্রুপ নির্বাচন করুন"; return; }
    if (APP.user) {
      startDonorSearch(view, selectedGroup);
    } else {
      const gateBox = h("div");
      view.appendChild(gateBox);
      renderAccountGate(gateBox, {
        intro: "আপনার মোবাইল নাম্বার প্রদান করুন…",
        onDone: () => startDonorSearch(view, selectedGroup),
      });
    }
  };
}

async function startDonorSearch(view, bloodGroup) {
  view.innerHTML = "";
  const box = h("div");
  view.appendChild(box);
  await showNextDonor(box, bloodGroup);
}

const CANNOT_REASONS = [
  { key: "not_yet_eligible", label: "রক্ত দেওয়ার সময় হয়নি" },
  { key: "far_away", label: "দূরে আছেন" },
  { key: "busy_today", label: "আজকে ব্যস্ত" },
  { key: "no_reason_given", label: "কারণ জানান নি" },
];

async function showNextDonor(box, bloodGroup) {
  box.innerHTML = "";
  setLoading(box);
  let res;
  try {
    res = await API.post("/api/seek/lock", { bloodGroup });
  } catch (e) {
    box.innerHTML = "";
    if (e.status === 429) {
      box.appendChild(h("div", { class: "card center stack" }, [icon("timer"), h("p", {}, e.message)]));
    } else {
      box.appendChild(errorBanner(e.message));
    }
    return;
  }
  box.innerHTML = "";

  if (!res.donor) {
    const card = h("div", { class: "card center stack" });
    card.appendChild(h("p", {}, "দুঃখিত, আমাদের আর কোনো ডোনারের তথ্য নেই। নিম্নোক্ত মাধ্যমসমূহে চেষ্টা করতে পারেন…"));
    const list = h("div", { class: "link-list" });
    (res.externalSources || []).forEach((s) => list.appendChild(h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.name)));
    card.appendChild(list);
    box.appendChild(card);
    return;
  }

  renderDonorCard(box, res.donor, bloodGroup);
}

function renderDonorCard(box, donor, bloodGroup) {
  box.innerHTML = "";
  const card = h("div", { class: "card donor-card" });
  card.appendChild(h("img", { class: "donor-card__pic", src: donor.profilePicUrl || pickDefaultAvatar(), alt: "" }));
  card.appendChild(h("div", { class: "donor-card__name" }, personLink(donor.name, donor.username)));
  const meta = donor.totalDonations > 0 ? `${donor.bloodGroup} (${toBnDigits(donor.totalDonations)} বার রক্তদান)` : donor.bloodGroup;
  card.appendChild(h("div", { class: "donor-card__meta" }, meta));

  const details = h("div", { class: "donor-card__details stack" });
  if (donor.addressSummary) details.appendChild(h("div", {}, [h("b", {}, "সংক্ষিপ্ত ঠিকানা: "), donor.addressSummary]));
  if (donor.lastDonationDate) details.appendChild(h("div", {}, [h("b", {}, "সর্বশেষ রক্তদান: "), bnDate(donor.lastDonationDate)]));
  card.appendChild(details);

  if (donor.note) card.appendChild(h("div", { class: "donor-card__note" }, `নোট: ${donor.note}`));

  const callBtn = h("button", { class: "btn btn-primary" }, [icon("phone", "small"), " কল করুন (" + donor.mobileMasked + ")"]);
  const statusBox = h("div", { style: "display:none;margin-top:14px" });
  card.appendChild(callBtn);
  card.appendChild(statusBox);
  box.appendChild(card);

  const timerSeconds = (APP.settings && APP.settings.callStatusTimerSeconds) || 20;
  let revealed = false;

  callBtn.onclick = async () => {
    // The button stays enabled/visible even after the timer elapses so the
    // requester can tap it again to redial - it does not lock or disappear.
    if (!revealed) {
      callBtn.disabled = true;
      let realMobile;
      try {
        const res = await API.get(`/api/seek/donor-number?donorId=${donor.id}`);
        realMobile = res.mobile;
      } catch (e) {
        toast(e.message);
        callBtn.disabled = false;
        return;
      }
      revealed = true;
      callBtn.dataset.mobile = realMobile;
      callBtn.disabled = false;
      callBtn.innerHTML = "";
      callBtn.appendChild(icon("phone", "small"));
      callBtn.append(" আবার কল করুন (" + realMobile + ")");
    }
    window.location.href = `tel:${callBtn.dataset.mobile}`;

    if (statusBox.dataset.started) return; // countdown/status UI only starts once
    statusBox.dataset.started = "1";
    let seconds = timerSeconds;
    const timerLine = h("p", { class: "center small muted" }, `${toBnDigits(seconds)} সেকেন্ড পর ষ্ট্যাটাস আপডেট করতে পারবেন…`);
    statusBox.style.display = "block";
    statusBox.appendChild(timerLine);
    const timer = setInterval(() => {
      seconds--;
      if (seconds <= 0) {
        clearInterval(timer);
        timerLine.remove();
        renderCallStatusButtons(statusBox, box, donor, bloodGroup, callBtn);
      } else {
        timerLine.textContent = `${toBnDigits(seconds)} সেকেন্ড পর ষ্ট্যাটাস আপডেট করতে পারবেন…`;
      }
    }, 1000);
  };

  box.appendChild(h("p", { class: "center small", style: "margin-top:14px" },
    h("a", { href: "#", onclick: (e) => { e.preventDefault(); renderBloodGroupStep(document.getElementById("view")); } }, "আবার শুরু")));
}

function renderCallStatusButtons(statusBox, box, donor, bloodGroup, callBtn) {
  statusBox.innerHTML = "";
  statusBox.appendChild(h("p", { class: "small muted" }, "কলের পর ষ্ট্যাটাস জানান:"));
  const options = [
    { key: "no_answer", label: "কল যাচ্ছে না" },
    { key: "not_picked_up", label: "কল ধরেনি" },
    { key: "cannot_donate", label: "রক্ত দিতে পারবে না" },
    { key: "can_donate", label: "রক্ত দিতে পারবে" },
  ];
  const row = h("div", { class: "stack" });
  options.forEach((opt) => {
    row.appendChild(h("button", { class: "btn btn-outline", onclick: () => handleCallStatus(statusBox, box, donor, bloodGroup, opt.key, callBtn) }, opt.label));
  });
  statusBox.appendChild(row);
}

async function handleCallStatus(statusBox, box, donor, bloodGroup, status, callBtn) {
  if (status === "cannot_donate") {
    statusBox.innerHTML = "";
    const card = h("div", { class: "stack" });
    card.appendChild(h("h3", {}, "কেন রক্ত দিতে পারবেন না?"));
    CANNOT_REASONS.forEach((r) => {
      card.appendChild(h("button", { class: "btn btn-outline", onclick: () => submitCallStatus(statusBox, box, donor, bloodGroup, status, r.key, callBtn) }, r.label));
    });
    statusBox.appendChild(card);
    return;
  }
  await submitCallStatus(statusBox, box, donor, bloodGroup, status, null, callBtn);
}

async function submitCallStatus(statusBox, box, donor, bloodGroup, status, cannotReason, callBtn) {
  try {
    await API.post("/api/seek/call-status", { donorId: donor.id, status, cannotReason });
  } catch (e) { toast(e.message); return; }

  // Once a status is recorded, the call button is hidden - re-dialing from
  // this card is no longer offered unless the requester explicitly says
  // the status was a mistake and picks again ("ভুল হয়েছে? আবার নির্বাচন করুন"),
  // which restores it.
  if (callBtn) callBtn.style.display = "none";

  statusBox.innerHTML = "";
  const resultCard = h("div", { class: "center stack" });
  if (status === "can_donate") {
    resultCard.appendChild(h("p", {}, "আলহামদুলিল্লাহ। রক্ত ম্যানেজ হয়েছে।"));
  } else {
    resultCard.appendChild(h("p", {}, "ষ্ট্যাটাস সংরক্ষণ করা হয়েছে।"));
    // Mistake correction: let the requester pick a different status for the
    // same call attempt instead of it being permanent.
    resultCard.appendChild(h("button", {
      class: "btn btn-outline",
      onclick: () => { if (callBtn) callBtn.style.display = ""; renderCallStatusButtons(statusBox, box, donor, bloodGroup, callBtn); },
    }, "ভুল হয়েছে? আবার নির্বাচন করুন"));
    resultCard.appendChild(h("button", { class: "btn btn-primary", onclick: () => showNextDonor(box, bloodGroup) }, "পরবর্তী ডোনার দেখুন"));
  }
  statusBox.appendChild(resultCard);
}

// ------------------------------------------------------------------ JOIN
ViewsPublic.join = function (view) {
  view.innerHTML = "";
  if (APP.user && APP.user.isDonor) { toast("আপনি ইতিমধ্যে ডোনার"); return navigate("/quick"); }

  view.appendChild(h("h2", {}, "রক্ত দিতে প্রস্তুত"));
  const box = h("div");
  view.appendChild(box);

  if (APP.user) {
    renderDonorInfoForm(box);
  } else {
    renderAccountGate(box, { intro: "আপনার মোবাইল নাম্বার প্রদান করুন…", onDone: () => renderDonorInfoForm(box) });
  }
};

async function renderDonorInfoForm(box) {
  box.innerHTML = "";
  const card = h("div", { class: "card stack" });
  let bloodGroup = null;
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "আপনার রক্তের গ্রুপ"), bloodGroupGrid(null, (g) => (bloodGroup = g))]));
  const dateField = h("input", { type: "date", max: todayIsoDate() });
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "সর্বশেষ রক্তদানের তারিখ (যদি থাকে)"), dateField]));
  const addrField = h("input", { type: "text", placeholder: "যেমনঃ পাঁচলাইশ, চট্টগ্রাম" });
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "সংক্ষিপ্ত ঠিকানা"), addrField]));
  const submitBtn = h("button", { class: "btn btn-accent" }, "সাবমিট করুন");
  card.appendChild(submitBtn);
  box.appendChild(card);
  enterSubmits([dateField, addrField], submitBtn);

  submitBtn.onclick = async () => {
    if (!bloodGroup) { toast("রক্তের গ্রুপ নির্বাচন করুন"); return; }
    submitBtn.disabled = true;
    try {
      await API.post("/api/profile/become-donor", { bloodGroup, lastDonationDate: dateField.value || null, addressSummary: addrField.value });
      APP.user.isDonor = true;
      toast("ধন্যবাদ! আপনি এখন একজন ডোনার।");
      navigate("/profile");
    } catch (e) { toast(e.message); } finally { submitBtn.disabled = false; }
  };
}

// ------------------------------------------------------------ PUBLIC PROFILE
ViewsPublic.publicProfile = async function (view, slug) {
  const { profile } = await API.get(`/api/u/${encodeURIComponent(slug)}`);
  view.innerHTML = "";
  const card = h("div", { class: "card donor-card" });
  card.appendChild(h("img", { class: "donor-card__pic", src: profile.profilePicUrl || pickDefaultAvatar(), alt: "" }));
  card.appendChild(h("div", { class: "donor-card__name" }, profile.name || profile.username));
  if (profile.isDonor) {
    const meta = profile.totalDonations != null && profile.totalDonations > 0 ? `${profile.bloodGroup} (${toBnDigits(profile.totalDonations)} বার রক্তদান)` : profile.bloodGroup;
    card.appendChild(h("div", { class: "donor-card__meta" }, meta));
    if (profile.eligibilityLabel) {
      const badgeClass = profile.eligibilityStatus === "on" ? "badge-on" : profile.eligibilityStatus === "snoozed" ? "badge-snoozed" : "badge-off";
      card.appendChild(h("div", { style: "margin-top:6px" }, h("span", { class: "badge " + badgeClass }, `বর্তমান এলিজিবিলিটি: ${profile.eligibilityLabel}`)));
    }
  }
  if (profile.note) card.appendChild(h("div", { class: "donor-card__note" }, `নোট: ${profile.note}`));
  view.appendChild(card);

  const info = h("div", { class: "card stack" });
  info.appendChild(h("h3", {}, "ডোনারের তথ্য"));
  if (profile.addressSummary) info.appendChild(h("div", {}, [h("b", {}, "সংক্ষিপ্ত ঠিকানা: "), profile.addressSummary]));
  if (profile.lastDonationDate) info.appendChild(h("div", {}, [h("b", {}, "সর্বশেষ রক্তদান: "), bnDate(profile.lastDonationDate)]));
  if (profile.mobile) info.appendChild(h("div", {}, [h("b", {}, "মোবাইল: "), profile.mobile]));
  if (profile.locationName) info.appendChild(h("div", {}, [h("b", {}, "লোকেশন: "), profile.locationName]));
  view.appendChild(info);

  if (profile.donationHistoryVisible) {
    const donCard = h("div", { class: "card stack" });
    donCard.appendChild(h("h3", {}, "পূর্বের ডোনেশনসমূহ"));
    const donations = profile.donations || [];
    if (!donations.length && !profile.extraDonationCount) {
      donCard.appendChild(h("p", { class: "muted" }, "কোনো তথ্য নেই"));
    } else {
      donations.forEach((d) => donCard.appendChild(h("div", { class: "list-item" }, [
        h("span", {}, bnDate(d.donation_date)), h("span", { class: "muted" }, d.hospital_name || ""),
      ])));
      if (profile.extraDonationCount) donCard.appendChild(h("p", { class: "muted small" }, `…এবং আরো ${toBnDigits(profile.extraDonationCount)} বার`));
    }
    view.appendChild(donCard);
  }

  if (profile.callHistoryVisible) {
    const callCard = h("div", { class: "card stack" });
    callCard.appendChild(h("h3", {}, "কল হিষ্ট্রি"));
    const calls = profile.calls || [];
    if (!calls.length) callCard.appendChild(h("p", { class: "muted" }, "কোনো কল হিষ্ট্রি নেই"));
    calls.forEach((c) => callCard.appendChild(h("div", { class: "list-item" }, h("span", {}, [
      personLink(c.personLabel, c.slug), " " + c.suffixText,
    ]))));
    view.appendChild(callCard);
  }

  const other = h("div", { class: "card stack" });
  other.appendChild(h("h3", {}, "অন্যান্য"));
  other.appendChild(h("div", {}, [h("b", {}, "প্ল্যাটফর্মে জয়েন করেছেন: "), bnDate(profile.joinedAt)]));
  other.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল করেছেন: "), toBnDigits(profile.totalCallsMade)]));
  if (profile.donorsManagedCount > 0) other.appendChild(h("div", {}, [h("b", {}, "রক্তদাতা পেয়েছেন: "), `${toBnDigits(profile.donorsManagedCount)} বার`]));
  if (profile.isDonor) other.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল রিসিভ করেছেন: "), toBnDigits(profile.totalCallsReceived)]));
  view.appendChild(other);
};
