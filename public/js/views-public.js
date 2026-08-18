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
  const cards = h("div", { class: "choice-cards" }, [
    h("a", { href: "/seek", "data-link": "", class: "choice-card choice-card--seek" }, [
      icon("hand-heart", "icon"), h("b", {}, "রক্ত দরকার"), h("span", { class: "muted" }, "রক্তদাতা খুঁজুন এখনই"),
    ]),
    h("a", { href: "/join", "data-link": "", class: "choice-card choice-card--donate" }, [
      icon("droplets", "icon"), h("b", {}, "রক্ত দিতে প্রস্তুত"), h("span", { class: "muted" }, "ডোনার হিসেবে যুক্ত হোন"),
    ]),
  ]);
  view.appendChild(cards);
  view.appendChild(pulseDivider());
  view.appendChild(h("p", { class: "center small" }, [
    !APP.user ? h("a", { href: "/login", "data-link": "" }, "লগইন") : h("span", { class: "muted" }, `স্বাগতম, ${APP.user.name || APP.user.mobile}`),
  ]));
};

// ------------------------------------------------------------ ACCOUNT GATE
// Shared mobile -> (password | OTP+new password) flow used by both /seek
// (as a requester) and /join (as a donor). Calls onDone() once logged in.
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
  const btn = h("button", { class: "back-btn", type: "button" }, [icon("chevron-left"), "মোবাইল নাম্বার পরিবর্তন করুন"]);
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
  forgotLink.onclick = (e) => { e.preventDefault(); renderOtpStep(container, mobile, "reset", onDone, onBack); };
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
  const errBox = h("div", { class: "field-error" });
  const submitBtn = h("button", { class: "btn btn-primary" }, purpose === "reset" ? "পাসওয়ার্ড রিসেট করুন" : "নিশ্চিত করুন");
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "ওটিপি কোড"), otpField]));
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "আপনার ইচ্ছেমতো নতুন পাসওয়ার্ড"), pwWrap, errBox]));
  card.appendChild(submitBtn);
  container.appendChild(card);
  enterSubmits([otpField, pwField], submitBtn);
  otpField.focus();

  submitBtn.onclick = async () => {
    errBox.textContent = "";
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
ViewsPublic.seek = function (view) {
  view.innerHTML = "";
  let selectedGroup = null;

  const groupCard = h("div", { class: "card stack" });
  groupCard.appendChild(h("h2", {}, "কোন গ্রুপের রক্ত প্রয়োজন?"));
  const countLine = h("p", { class: "muted" });
  const grid = bloodGroupGrid(null, async (g) => {
    selectedGroup = g;
    countLine.textContent = "লোড হচ্ছে…";
    try {
      const { count } = await API.get(`/api/seek/count?bloodGroup=${encodeURIComponent(g)}`);
      countLine.textContent = `${count} জন উপযুক্ত রক্তদাতা রয়েছেন।`;
      gateBox.style.display = "block";
    } catch (e) { countLine.textContent = ""; toast(e.message); }
  });
  groupCard.appendChild(grid);
  groupCard.appendChild(countLine);
  view.appendChild(groupCard);

  const gateBox = h("div", { style: "display:none" });
  view.appendChild(gateBox);

  renderAccountGate(gateBox, {
    intro: "আপনার মোবাইল নাম্বার প্রদান করুন…",
    onDone: () => startDonorSearch(view, selectedGroup),
  });
  // hide gate initially until a blood group is chosen
  gateBox.style.display = APP.user ? "block" : "none";
  if (APP.user) {
    // if already logged in, wait for group selection then go straight to search
    grid.addEventListener("click", () => {}, true);
  }
};

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
    card.appendChild(h("button", { class: "btn btn-outline", onclick: () => showNextDonor(box, bloodGroup) }, "আবার চেষ্টা করুন"));
    box.appendChild(card);
    return;
  }

  renderDonorCard(box, res.donor, bloodGroup);
}

function renderDonorCard(box, donor, bloodGroup) {
  const card = h("div", { class: "card donor-card" });
  card.appendChild(h("img", { class: "donor-card__pic", src: donor.profilePicUrl || "/img/logo.png", alt: "" }));
  card.appendChild(h("div", { class: "donor-card__name" }, donor.username ? h("a", { href: `/${donor.username}`, "data-link": "" }, donor.name) : donor.name));
  const meta = donor.totalDonations > 0 ? `${donor.bloodGroup} (${donor.totalDonations} বার রক্তদান)` : donor.bloodGroup;
  card.appendChild(h("div", { class: "donor-card__meta" }, meta));

  const details = h("div", { class: "donor-card__details stack" });
  if (donor.addressSummary) details.appendChild(h("div", {}, [h("b", {}, "ঠিকানা: "), donor.addressSummary]));
  if (donor.lastDonationDate) details.appendChild(h("div", {}, [h("b", {}, "সর্বশেষ রক্তদান: "), bnDate(donor.lastDonationDate)]));
  card.appendChild(details);

  if (donor.note) card.appendChild(h("div", { class: "donor-card__note" }, `নোট: ${donor.note}`));

  const callBtn = h("button", { class: "btn btn-primary" }, [icon("phone", "small"), " কল করুন (" + donor.mobileMasked + ")"]);
  const numberLine = h("p", { class: "center small muted", style: "display:none" });
  const statusBox = h("div", { style: "display:none;margin-top:14px" });
  card.appendChild(callBtn);
  card.appendChild(numberLine);
  card.appendChild(statusBox);
  box.appendChild(card);

  callBtn.onclick = async () => {
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
    numberLine.textContent = `নাম্বার: ${realMobile}`;
    numberLine.style.display = "block";
    window.location.href = `tel:${realMobile}`;
    let seconds = 20;
    callBtn.textContent = `২০ সেকেন্ড অপেক্ষা করুন (${seconds})`;
    const timer = setInterval(() => {
      seconds--;
      if (seconds <= 0) {
        clearInterval(timer);
        statusBox.style.display = "block";
        renderCallStatusButtons(statusBox, box, donor, bloodGroup);
      } else {
        callBtn.textContent = `২০ সেকেন্ড অপেক্ষা করুন (${seconds})`;
      }
    }, 1000);
  };

  box.appendChild(h("p", { class: "center small", style: "margin-top:14px" },
    h("a", { href: "#", onclick: (e) => { e.preventDefault(); ViewsPublic.seek(document.getElementById("view")); } }, "আবার শুরু")));
}

function renderCallStatusButtons(statusBox, box, donor, bloodGroup) {
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
    row.appendChild(h("button", { class: "btn btn-outline", onclick: () => handleCallStatus(box, donor, bloodGroup, opt.key) }, opt.label));
  });
  statusBox.appendChild(row);
}

async function handleCallStatus(box, donor, bloodGroup, status) {
  if (status === "cannot_donate") {
    box.innerHTML = "";
    const card = h("div", { class: "card stack" });
    card.appendChild(h("h3", {}, "কেন রক্ত দিতে পারবেন না?"));
    CANNOT_REASONS.forEach((r) => {
      card.appendChild(h("button", { class: "btn btn-outline", onclick: () => submitCallStatus(box, donor, bloodGroup, status, r.key) }, r.label));
    });
    box.appendChild(card);
    return;
  }
  await submitCallStatus(box, donor, bloodGroup, status, null);
}

async function submitCallStatus(box, donor, bloodGroup, status, cannotReason) {
  try {
    await API.post("/api/seek/call-status", { donorId: donor.id, status, cannotReason });
  } catch (e) { toast(e.message); }

  box.innerHTML = "";
  if (status === "can_donate") {
    const card = h("div", { class: "card center stack" });
    card.appendChild(h("p", {}, "আলহামদুলিল্লাহ। রক্ত ম্যানেজ হয়েছে।"));
    card.appendChild(h("a", { href: "/", "data-link": "", class: "btn btn-primary" }, "মেইন মেনু"));
    box.appendChild(card);
  } else {
    const card = h("div", { class: "card center stack" });
    card.appendChild(h("p", {}, "ষ্ট্যাটাস সংরক্ষণ করা হয়েছে।"));
    card.appendChild(h("button", { class: "btn btn-primary", onclick: () => showNextDonor(box, bloodGroup) }, "পরবর্তী ডোনার দেখুন"));
    card.appendChild(h("a", { href: "/", "data-link": "", class: "btn btn-outline" }, "মেইন মেনু"));
    box.appendChild(card);
  }
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
  const dateField = h("input", { type: "date" });
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
  card.appendChild(h("img", { class: "donor-card__pic", src: profile.profilePicUrl || "/img/logo.png", alt: "" }));
  card.appendChild(h("div", { class: "donor-card__name" }, profile.name || profile.username));
  if (profile.isDonor) {
    const meta = profile.totalDonations > 0 ? `${profile.bloodGroup} (${profile.totalDonations} বার রক্তদান)` : profile.bloodGroup;
    card.appendChild(h("div", { class: "donor-card__meta" }, meta));
  }
  if (profile.note) card.appendChild(h("div", { class: "donor-card__note" }, `নোট: ${profile.note}`));
  view.appendChild(card);

  const info = h("div", { class: "card stack" });
  info.appendChild(h("h3", {}, "ডোনারের তথ্য"));
  if (profile.addressSummary) info.appendChild(h("div", {}, [h("b", {}, "সংক্ষিপ্ত ঠিকানা: "), profile.addressSummary]));
  if (profile.lastDonationDate) info.appendChild(h("div", {}, [h("b", {}, "সর্বশেষ রক্তদান: "), bnDate(profile.lastDonationDate)]));
  if (profile.mobile) info.appendChild(h("div", {}, [h("b", {}, "মোবাইল: "), profile.mobile]));
  view.appendChild(info);

  const other = h("div", { class: "card stack" });
  other.appendChild(h("h3", {}, "অন্যান্য"));
  other.appendChild(h("div", {}, [h("b", {}, "প্ল্যাটফর্মে জয়েন করেছেন: "), bnDate(profile.joinedAt)]));
  other.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল করেছেন: "), String(profile.totalCallsMade)]));
  if (profile.donorsManagedCount > 0) other.appendChild(h("div", {}, [h("b", {}, "রক্তদাতা পেয়েছেন: "), `${profile.donorsManagedCount} বার`]));
  if (profile.isDonor) other.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল রিসিভ করেছেন: "), String(profile.totalCallsReceived)]));
  if (profile.locationName) other.appendChild(h("div", {}, [h("b", {}, "লোকেশন: "), profile.locationName]));
  view.appendChild(other);
};
