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
  let overLimitMessage = null;
  try {
    const res = await API.post("/api/otp/send", { mobile, purpose });
    if (res.overLimitMessage) overLimitMessage = res.overLimitMessage;
    else toast("OTP পাঠানো হয়েছে");
  } catch (e) { toast(e.message); }

  const card = h("div", { class: "card stack" });
  const otpField = h("input", { type: "text", inputmode: "numeric", maxlength: "6", placeholder: "৬ সংখ্যার OTP" });
  const pwWrap = passwordField("আপনার ইচ্ছেমতো নতুন পাসওয়ার্ড");
  const pwField = pwWrap.querySelector("input");
  const confirmWrap = passwordField("নতুন পাসওয়ার্ড আবার লিখুন");
  const confirmField = confirmWrap.querySelector("input");
  const errBox = h("div", { class: "field-error" });
  const submitBtn = h("button", { class: "btn btn-primary" }, purpose === "reset" ? "পাসওয়ার্ড রিসেট করুন" : "নিশ্চিত করুন");
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "ওটিপি কোড"), otpField]));
  // Shown when the recipient has hit their daily SMS cap - the OTP flow
  // still continues (the field stays usable in case the person already
  // knows a manually-provided code from the admin), but they're told why
  // nothing arrived, with the admin-configurable contact instruction.
  if (overLimitMessage) card.appendChild(h("p", { class: "field-error small" }, overLimitMessage));
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "আপনার ইচ্ছেমতো নতুন পাসওয়ার্ড"), pwWrap]));
  card.appendChild(h("div", { class: "field" }, [h("label", {}, "নতুন পাসওয়ার্ড আবার লিখুন"), confirmWrap, errBox]));
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
ViewsPublic.seek = async function (view, params) {
  view.innerHTML = "";
  const bgFromUrl = normalizeBloodGroupParam(params ? params.get("bg") : null);
  renderBloodGroupStep(view, bgFromUrl);
};

const SEEK_BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"];

// A literal "+" typed in a URL's query string (e.g. .../seek?bg=A+, exactly
// how someone would naturally write or share it) is NOT the same as an
// encoded "%2B" - per the query-string convention, an unencoded "+"
// decodes to a space, so URLSearchParams hands back "A " (trailing space),
// not "A+". Since a plain, unencoded "+" is the realistic case for a link
// someone hand-types or pastes, trim a trailing space back into "+" before
// validating rather than requiring the sender to properly percent-encode
// it. Also accepts spelled-out word suffixes as an alternative to the
// symbol - positive/pos -> "+", negative/neg -> "-" (case-insensitive),
// e.g. ?bg=Apositive, ?bg=Apos, ?bg=Anegative, ?bg=Aneg all resolve the
// same as ?bg=A+ / ?bg=A-. Checked longest-suffix-first so "POSITIVE"
// isn't mistaken for ending in "POS" before the fuller word is tried.
//
// KEEP IN SYNC: src/lib/blood-group.js has the Worker-side copy of this
// same function (used by src/worker.js and src/handlers/telegram.js). This
// file is a plain browser <script> (see public/index.html), not an ES
// module, and this app has no bundler/build step, so it can't import that
// src/lib module - hence the verbatim duplication. If you change this
// function's behavior, mirror the change there too.
const BLOOD_GROUP_WORD_SUFFIXES = [["POSITIVE", "+"], ["NEGATIVE", "-"], ["POS", "+"], ["NEG", "-"], ["P", "+"], ["N", "-"]];
function normalizeBloodGroupParam(raw) {
  if (!raw) return null;
  let v = raw.trim();
  if (raw.endsWith(" ") && !v.endsWith("+") && !v.endsWith("-")) v += "+";
  v = v.toUpperCase();
  for (const [word, symbol] of BLOOD_GROUP_WORD_SUFFIXES) {
    if (v.endsWith(word)) { v = v.slice(0, -word.length) + symbol; break; }
  }
  return v;
}

// Reverse of normalizeBloodGroupParam - shortest possible ?bg= code for a
// given canonical group, used when building a shareable link (e.g. "O+" ->
// "op", "AB-" -> "abn"). Kept short so the link looks clean when pasted
// into WhatsApp/SMS - the full symbol ("O+") also works fine (see
// normalizeBloodGroupParam) but "+" needs percent-encoding to survive a
// URL cleanly, which "p"/"n" avoids entirely.
function shortBloodGroupCode(g) {
  if (!g) return "";
  return g.endsWith("+") ? g.slice(0, -1).toLowerCase() + "p" : g.slice(0, -1).toLowerCase() + "n";
}

// English hh:mm am/pm + short month/day, matching the format used in the
// seek link's shared preview text (e.g. "07:33pm, Sep 23") - distinct from
// the Bengali-digit bnDateTime/bnDateTimeLong formatters in ui.js, which
// are used everywhere else in the app.
const EN_MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function enTimeShort(d) {
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${String(hours).padStart(2, "0")}:${minutes}${ampm}, ${EN_MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

// presetGroup comes from a shared /seek?bg=A+ style link (see
// applyServerSideBranding in worker.js, which reads the same query param
// server-side to set the social-preview title/description) - when present
// and valid, the group is pre-selected and its donor count looked up
// immediately, as if the visitor had just tapped that button themselves.
function renderBloodGroupStep(view, presetGroup) {
  view.innerHTML = "";
  let selectedGroup = null;
  let lastCount = null;

  const groupCard = h("div", { class: "card stack" });
  const shareBtn = h("button", { type: "button", class: "seek-share-btn", "aria-label": "শেয়ার করুন", style: "display:none" }, [icon("share-2")]);
  groupCard.appendChild(h("div", { style: "position:relative;padding-right:44px" }, [
    h("div", { style: "display:flex;flex-direction:column;gap:2px" }, [
      h("p", { class: "muted small", style: "margin:0" }, "চট্টগ্রাম জেলায়..."),
      h("h2", { style: "margin:0" }, "কোন গ্রুপের রক্ত প্রয়োজন?"),
    ]),
    shareBtn,
  ]));
  const countLine = h("p", { class: "muted" });
  const groupErr = h("div", { class: "field-error" });
  const continueBtn = h("button", { class: "btn btn-primary", style: "display:none" }, "এগিয়ে যান");
  // Shown instead of continueBtn when the count comes back 0 - there's
  // nothing to search for regardless of login state, so a logged-out
  // visitor should see this immediately rather than being sent through
  // the mobile-number gate first only to land on the same message after.
  const noDonorBox = h("div", { class: "card center stack", style: "display:none" });

  async function selectGroup(g) {
    selectedGroup = g;
    groupErr.textContent = "";
    countLine.textContent = "লোড হচ্ছে…";
    shareBtn.style.display = "flex";
    continueBtn.style.display = "none";
    noDonorBox.style.display = "none";
    noDonorBox.innerHTML = "";
    try {
      const { count, externalSources } = await API.get(`/api/seek/count?bloodGroup=${encodeURIComponent(g)}`);
      lastCount = count;
      countLine.textContent = `${toBnDigits(count)} জন উপযুক্ত রক্তদাতা রয়েছেন।`;
      if (count === 0) {
        noDonorBox.appendChild(h("p", {}, "দুঃখিত! এই গ্রুপের কোনো রক্তদাতা আমাদের প্ল্যাটফর্মে বর্তমানে এভেইলেভল নেই। নিম্নোক্ত মাধ্যমসমূহে চেষ্টা করতে পারেন..."));
        const list = h("div", { class: "link-list" });
        (externalSources || []).forEach((s) => list.appendChild(h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.name)));
        noDonorBox.appendChild(list);
        noDonorBox.style.display = "flex";
      } else {
        continueBtn.style.display = "block";
      }
    } catch (e) { countLine.textContent = ""; toast(e.message); }
  }

  shareBtn.onclick = async () => {
    if (!selectedGroup) return;
    // A fresh random id on every share forces WhatsApp/Telegram/etc to
    // re-fetch the link's preview instead of reusing a stale cached one
    // from an earlier share of the same bg (see the caching note by
    // seekBrandOverride in worker.js) - it plays no other role and the
    // server ignores it entirely. 4 chars (base36) gives 36^4 (~1.68M)
    // combinations, plenty to dodge a cache collision for this purpose.
    const i = Math.random().toString(36).slice(2, 6);
    const url = new URL("/seek", location.origin);
    url.searchParams.set("bg", shortBloodGroupCode(selectedGroup));
    url.searchParams.set("i", i);
    const shareUrl = url.href;

    const countText = `${toBnDigits(lastCount ?? 0)} জন উপযুক্ত ${selectedGroup} রক্তদাতা`;
    const shareText = `${shareUrl}\n${countText} (${enTimeShort(new Date())})`;

    const copyMsg = `প্রি-ফিল মেসেজ কপি হয়েছে। এই লিংকে যারা ভিজিট করবে তাদের কাছে আগে থেকেই ${selectedGroup} রক্তের গ্রুপ নির্বাচিত থাকবে।`;
    await copyToClipboard(shareText, copyMsg);

    if (navigator.share) {
      try { await navigator.share({ text: shareText }); } catch { /* user cancelled the share sheet - the link is already copied above regardless */ }
    }
  };

  const validPreset = presetGroup && SEEK_BLOOD_GROUPS.includes(presetGroup) ? presetGroup : null;
  const grid = bloodGroupGrid(validPreset, (g) => selectGroup(g));
  groupCard.appendChild(grid);
  groupCard.appendChild(countLine);
  groupCard.appendChild(groupErr);
  groupCard.appendChild(continueBtn);
  groupCard.appendChild(noDonorBox);
  view.appendChild(groupCard);

  // A blood group must be selected before proceeding - enforced here
  // regardless of login state, not only after the login gate. The gate
  // box is created once and cleared+reused on every click rather than
  // appended fresh each time, since re-appending an already-attached
  // node just moves it (harmless) but re-creating+appending a NEW one on
  // every click stacked up one login form per click.
  const gateBox = h("div");
  continueBtn.onclick = () => {
    if (!selectedGroup) { groupErr.textContent = "রক্তের গ্রুপ নির্বাচন করুন"; return; }
    if (APP.user) {
      startDonorSearch(view, selectedGroup);
    } else {
      gateBox.innerHTML = "";
      view.appendChild(gateBox);
      renderAccountGate(gateBox, {
        intro: "আপনার মোবাইল নাম্বার প্রদান করুন…",
        onDone: () => startDonorSearch(view, selectedGroup),
      });
    }
  };

  if (validPreset) selectGroup(validPreset);
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

// Sub-reasons for the "কল করিনি" status - "other" (অন্যান্য) is a normal
// fixed reason like the first two, submitted immediately with no text
// required. The free-text custom option ("কাষ্টম ব্যখ্যা") is separate,
// rendered below as its own button that reveals an input field.
const NOT_CALLED_REASONS = [
  { key: "note_reason", label: "নোটের কারণে" },
  { key: "blood_not_needed", label: "ডোনারের লোকেশন দূরে" },
  { key: "other", label: "অন্যান্য" },
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

  renderDonorCard(box, res.donor, bloodGroup, res.alreadyCalled);
}

function renderDonorCard(box, donor, bloodGroup, alreadyCalled) {
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
  const skipBtn = h("button", { class: "btn btn-outline", style: "margin-top:8px" }, [icon("skip-forward", "small"), " স্কিপ করুন"]);
  const whatsappBtn = h("a", { class: "btn btn-outline", style: "display:none;margin-top:8px", target: "_blank", rel: "noopener" }, [icon("message-square", "small"), " হোয়াটসঅ্যাপে ওপেন করুন"]);
  const statusBox = h("div", { style: "display:none;margin-top:14px" });
  card.appendChild(callBtn);
  card.appendChild(skipBtn);
  card.appendChild(whatsappBtn);
  card.appendChild(statusBox);
  box.appendChild(card);

  const timerSeconds = (APP.settings && APP.settings.callStatusTimerSeconds) || 20;
  let revealed = false;
  let countdownTimer = null; // so skipBtn can cancel an in-progress countdown

  // Builds the wa.me link for the real (unmasked) number - only ever
  // called once the number is actually known (see the two call sites
  // below), matching the "below আবার কল করুন" placement in the spec since
  // that text change is the same moment the number becomes known.
  function showWhatsappButton(realMobile) {
    // BD mobiles are stored as 11 digits starting with 0 (e.g.
    // 01383600577) - wa.me needs the full international number with the
    // country code and no leading zero (8801383600577).
    const intlNumber = "880" + realMobile.replace(/^0/, "");
    const template = (APP.settings && APP.settings.whatsappSeekMessage) ||
      "আসসালামুআলাইকুম। আশা করি ভালো আছেন। {bloodGroup} রক্তদাতা খুঁজছিলাম। আপনি কি এভেইলেবল আছেন?";
    const message = template.replace(/\{bloodGroup\}/g, bloodGroup);
    whatsappBtn.href = `https://wa.me/${intlNumber}?text=${encodeURIComponent(message)}`;
    whatsappBtn.style.display = "inline-flex";
  }

  // If the call was already started before a refresh (number already
  // revealed, countdown already run or in progress server-side), skip
  // straight to the "already called" state instead of replaying the
  // reveal step and restarting the 20-second countdown from zero. The
  // exact mobile number itself isn't re-shown here (avoids a second
  // reveal call just to redisplay it), but the button still redials
  // correctly since donor-number is re-fetched on click same as before.
  // The WhatsApp button, however, DOES need the real number to build its
  // link, so it stays hidden in this branch until the person actually
  // taps কল/আবার কল করুন at least once this page load.
  if (alreadyCalled) {
    revealed = true;
    callBtn.innerHTML = "";
    callBtn.appendChild(icon("phone", "small"));
    callBtn.append(" আবার কল করুন");
    callBtn.dataset.needsNumber = "1";
    statusBox.dataset.started = "1";
    statusBox.style.display = "block";
    skipBtn.style.display = "none";
    skipBtn.dataset.callLocked = "1";
    renderCallStatusButtons(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn);
  }

  // Jumps straight to the same sub-reason screen "কল করিনি" uses (just a
  // different header/status - see renderSkippedReasons), without ever
  // requiring the requester to reveal the number or dial first. Works even
  // if a call countdown is already running - cancels it rather than being
  // blocked by statusBox.dataset.started, since skipping is meant to always
  // be available as an alternative to the call flow, not just before it.
  skipBtn.onclick = () => {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    statusBox.dataset.started = "1";
    statusBox.style.display = "block";
    renderSkippedReasons(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn);
  };

  callBtn.onclick = async () => {
    // The button stays enabled/visible even after the timer elapses so the
    // requester can tap it again to redial - it does not lock or disappear.
    if (!revealed || callBtn.dataset.needsNumber) {
      callBtn.disabled = true;
      let realMobile;
      try {
        const res = await API.get(`/api/seek/donor-number?donorId=${donor.id}&bloodGroup=${encodeURIComponent(bloodGroup)}`);
        realMobile = res.mobile;
      } catch (e) {
        toast(e.message);
        callBtn.disabled = false;
        return;
      }
      revealed = true;
      delete callBtn.dataset.needsNumber;
      callBtn.dataset.mobile = realMobile;
      callBtn.disabled = false;
      callBtn.innerHTML = "";
      callBtn.appendChild(icon("phone", "small"));
      callBtn.append(" আবার কল করুন (" + realMobile + ")");
      showWhatsappButton(realMobile);
    }
    window.location.href = `tel:${callBtn.dataset.mobile}`;

    // Skipping is an alternative TO calling - once a call has been placed
    // it no longer applies, so the skip button goes away (and stays away
    // even if the status is later corrected, see submitCallStatus).
    skipBtn.style.display = "none";
    skipBtn.dataset.callLocked = "1";

    if (statusBox.dataset.started) return; // countdown/status UI only starts once
    statusBox.dataset.started = "1";
    let seconds = timerSeconds;
    const timerLine = h("p", { class: "center small muted" }, `${toBnDigits(seconds)} সেকেন্ড পর ষ্ট্যাটাস আপডেট করতে পারবেন…`);
    statusBox.style.display = "block";
    statusBox.appendChild(timerLine);
    countdownTimer = setInterval(() => {
      seconds--;
      if (seconds <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        timerLine.remove();
        renderCallStatusButtons(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn);
      } else {
        timerLine.textContent = `${toBnDigits(seconds)} সেকেন্ড পর ষ্ট্যাটাস আপডেট করতে পারবেন…`;
      }
    }, 1000);
  };

  box.appendChild(h("p", { class: "center small muted", style: "margin-top:14px" },
    "এই ডোনারকে কল করার পর ষ্ট্যাটাস জানিয়ে আরো ডোনার থাকলে, একে একে তাদের নাম্বার দেখতে পাবেন।"));
  box.appendChild(h("p", { class: "center small" },
    h("a", { href: "#", onclick: (e) => { e.preventDefault(); renderBloodGroupStep(document.getElementById("view")); } }, "আবার শুরু")));
}

function renderCallStatusButtons(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn) {
  statusBox.innerHTML = "";
  statusBox.appendChild(h("p", { class: "small muted" }, "কলের পর ষ্ট্যাটাস জানান:"));
  const options = [
    { key: "no_answer", label: "কল যাচ্ছে না" },
    { key: "not_picked_up", label: "কল ধরেনি" },
    { key: "cannot_donate", label: "রক্ত দিতে পারবে না" },
    { key: "can_donate", label: "রক্ত দিতে পারবে" },
    { key: "not_called", label: "কল করিনি" },
  ];
  const row = h("div", { class: "stack" });
  options.forEach((opt) => {
    row.appendChild(h("button", { class: "btn btn-outline", onclick: () => handleCallStatus(statusBox, box, donor, bloodGroup, opt.key, callBtn, whatsappBtn, skipBtn) }, opt.label));
  });
  statusBox.appendChild(row);
  statusBox.appendChild(h("p", { class: "small muted", style: "margin-top:10px" },
    "আপনার প্রদত্ত ষ্ট্যাটাস এর মাধ্যমে সিদ্ধান্ত নেয়া হবে এই ডোনারের তথ্য অন্যান্য সিকারদের কাছে দেখানো হবে কি না"));
}

async function handleCallStatus(statusBox, box, donor, bloodGroup, status, callBtn, whatsappBtn, skipBtn) {
  if (status === "cannot_donate") {
    statusBox.innerHTML = "";
    const card = h("div", { class: "stack" });
    card.appendChild(h("h3", {}, "কেন রক্ত দিতে পারবেন না?"));
    CANNOT_REASONS.forEach((r) => {
      card.appendChild(h("button", { class: "btn btn-outline", onclick: () => submitCallStatus(statusBox, box, donor, bloodGroup, status, r.key, callBtn, whatsappBtn, skipBtn) }, r.label));
    });
    statusBox.appendChild(card);
    return;
  }
  if (status === "not_called") {
    renderNotCalledReasons(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn);
    return;
  }
  await submitCallStatus(statusBox, box, donor, bloodGroup, status, null, callBtn, whatsappBtn, skipBtn);
}

// Shared by "কল করিনি" (not_called) and "স্কিপ করুন" (skipped) - identical
// three fixed reasons - only the recorded status value and the question
// header differ. The free-text "কাষ্টম ব্যখ্যা" option (up to 100 chars) is
// offered for "কল করিনি" only, not for a skip.
function renderReasonSubScreen(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn, status, headerText) {
  statusBox.innerHTML = "";
  const card = h("div", { class: "stack" });
  card.appendChild(h("h3", {}, headerText));
  NOT_CALLED_REASONS.forEach((r) => {
    card.appendChild(h("button", { class: "btn btn-outline", onclick: () => submitCallStatus(statusBox, box, donor, bloodGroup, status, r.key, callBtn, whatsappBtn, skipBtn) }, r.label));
  });

  if (status !== "skipped") {
    const customField = h("input", { type: "text", maxlength: "100", placeholder: "নিজে লিখুন", style: "display:none;margin-top:6px" });
    const submitCustomBtn = h("button", { class: "btn btn-primary", style: "display:none;margin-top:6px", onclick: () => {
      const text = customField.value.trim();
      if (!text) { toast("লিখুন"); return; }
      submitCallStatus(statusBox, box, donor, bloodGroup, status, text, callBtn, whatsappBtn, skipBtn);
    } }, "সাবমিট করুন");
    customField.oninput = () => { submitCustomBtn.style.display = customField.value.trim() ? "block" : "none"; };
    card.appendChild(h("button", { class: "btn btn-outline", onclick: () => { customField.style.display = "block"; customField.focus(); } }, "কাষ্টম ব্যখ্যা"));
    card.appendChild(customField);
    card.appendChild(submitCustomBtn);
  }

  statusBox.appendChild(card);
}

function renderNotCalledReasons(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn) {
  renderReasonSubScreen(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn, "not_called", "কেন কল করেননি?");
}

// Recorded as its own "skipped" status (never "not_called") even though it
// reuses the exact same reason sub-screen - see the comment on
// STATUS_LABELS_BN.skipped in callLabels.js for why they're kept distinct.
function renderSkippedReasons(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn) {
  renderReasonSubScreen(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn, "skipped", "কেন স্কিপ করেছেন?");
}

async function submitCallStatus(statusBox, box, donor, bloodGroup, status, cannotReason, callBtn, whatsappBtn, skipBtn) {
  try {
    await API.post("/api/seek/call-status", { donorId: donor.id, status, cannotReason });
  } catch (e) { toast(e.message); return; }

  // Once a status is recorded, the call button, the WhatsApp button, AND
  // the skip button are all hidden - re-messaging/re-dialing/skipping from
  // this card is no longer offered unless the requester explicitly says the
  // status was a mistake and picks again ("ভুল হয়েছে? আবার নির্বাচন করুন"),
  // which restores all three.
  if (callBtn) callBtn.style.display = "none";
  if (whatsappBtn) whatsappBtn.style.display = "none";
  if (skipBtn) skipBtn.style.display = "none";

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
      onclick: () => {
        if (callBtn) callBtn.style.display = "";
        if (whatsappBtn && whatsappBtn.href) whatsappBtn.style.display = "inline-flex";
        if (skipBtn && !skipBtn.dataset.callLocked) skipBtn.style.display = "";
        renderCallStatusButtons(statusBox, box, donor, bloodGroup, callBtn, whatsappBtn, skipBtn);
      },
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
      toast("ধন্যবাদ। আপনি এখন একজন ডোনার। রক্তদানে প্রস্তুত থাকলে অনুগ্রহ করে সুইচ চালু করে দিন!");
      navigate("/quick");
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
      const badgeRow = h("div", { style: "margin-top:6px" }, h("span", { class: "badge " + badgeClass }, `বর্তমান এলিজিবিলিটি: ${profile.eligibilityLabel}`));
      // Timer only makes sense (and is only shown) for the temporary
      // "snoozed" state - "on"/"off" have no countdown to display.
      if (profile.eligibilityStatus === "snoozed" && profile.eligibilitySnoozeUntil) {
        badgeRow.appendChild(inlineCountdown(profile.eligibilitySnoozeUntil));
      }
      card.appendChild(badgeRow);
    }
  }
  if (profile.note) card.appendChild(h("div", { class: "donor-card__note" }, `নোট: ${profile.note}`));
  view.appendChild(card);

  // The header card above (picture/name/eligibility) is always shown as-is;
  // everything below is organized as either stacked sections (list view) or
  // tabs (tab view, default) per the donor's own Edit Profile preference.
  const sections = [];

  const info = h("div", { class: "stack" });
  if (profile.addressSummary) info.appendChild(h("div", {}, [h("b", {}, "সংক্ষিপ্ত ঠিকানা: "), profile.addressSummary]));
  if (profile.lastDonationDate) info.appendChild(h("div", {}, [h("b", {}, "সর্বশেষ রক্তদান: "), bnDate(profile.lastDonationDate)]));
  if (profile.mobile) info.appendChild(h("div", {}, [h("b", {}, "মোবাইল: "), profile.mobile]));
  if (profile.locationName) info.appendChild(h("div", {}, [h("b", {}, "লোকেশন: "), profile.locationName]));
  sections.push({ key: "info", label: "তথ্য", content: info });

  if (profile.donationHistoryVisible) {
    const donContent = h("div", { class: "stack" });
    const donations = profile.donations || [];
    if (!donations.length && !profile.extraDonationCount) {
      donContent.appendChild(h("p", { class: "muted" }, "কোনো তথ্য নেই"));
    } else {
      donations.forEach((d) => donContent.appendChild(h("div", { class: "list-item" }, [
        h("span", {}, d.donation_date ? bnDate(d.donation_date) : "—"), h("span", { class: "muted" }, d.hospital_name || ""),
      ])));
      if (profile.extraDonationCount) donContent.appendChild(h("p", { class: "muted small" }, `…এবং আরো ${toBnDigits(profile.extraDonationCount)} বার`));
    }
    sections.push({ key: "donations", label: "ডোনেশন", content: donContent });
  }

  if (profile.callHistoryVisible) {
    const callContent = h("div", { class: "stack" });
    const calls = profile.calls || [];
    if (!calls.length) {
      callContent.appendChild(h("p", { class: "muted" }, "কোনো কল হিষ্ট্রি নেই"));
    } else {
      // Same caption/table format as the owner's own profile calls tab
      // (renderProfileCallsTab in views-account.js) - profile.calls is now
      // sourced from the same receivedCallsSummaryFor shape on the backend
      // (capped at 5, requesterLabel/requesterSlug/statusPhrase/createdAt),
      // just without the aggregate counters card shown on the owner's side.
      callContent.appendChild(h("p", { class: "muted small" }, "প্রোফাইল হোল্ডারকে করা সর্বশেষ ৫টি কল..."));
      const table = h("table", { class: "activity-log-table profile-calls-table" });
      table.appendChild(h("thead", {}, h("tr", {}, [h("th", {}, "কল করেছিলো"), h("th", {}, "ষ্ট্যাটাস")])));
      const tbody = h("tbody");
      calls.forEach((c) => {
        tbody.appendChild(h("tr", {}, [
          h("td", {}, [personLink(c.requesterLabel, c.requesterSlug), h("div", { class: "small muted" }, bnDateTimeLong(c.createdAt))]),
          h("td", {}, c.statusPhrase),
        ]));
      });
      table.appendChild(tbody);
      callContent.appendChild(table);
    }
    sections.push({ key: "calls", label: "কল হিষ্ট্রি", content: callContent });
  }

  const other = h("div", { class: "stack" });
  other.appendChild(h("div", {}, [h("b", {}, "প্ল্যাটফর্মে জয়েন করেছেন: "), bnDate(profile.joinedAt)]));
  other.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল করেছেন: "), toBnDigits(profile.totalCallsMade)]));
  if (profile.donorsManagedCount > 0) other.appendChild(h("div", {}, [h("b", {}, "রক্তদাতা পেয়েছেন: "), `${toBnDigits(profile.donorsManagedCount)} বার`]));
  if (profile.isDonor) other.appendChild(h("div", {}, [h("b", {}, "সর্বমোট কল রিসিভ করেছেন: "), toBnDigits(profile.totalCallsReceived)]));
  sections.push({ key: "other", label: "অন্যান্য", content: other });

  if (profile.publicProfileView === "list") {
    sections.forEach((s) => {
      const sCard = h("div", { class: "card stack" });
      sCard.appendChild(h("h3", {}, s.label));
      sCard.appendChild(s.content);
      view.appendChild(sCard);
    });
  } else {
    // Tab view (default): a single card with a tab strip up top and only
    // the active section's content shown below it.
    const tabCard = h("div", { class: "card" });
    const tabStrip = h("div", { class: "profile-tabs" });
    const bodyWrap = h("div", { class: "profile-tab-body", style: "margin-top:14px" });
    sections.forEach((s, i) => {
      const btn = h("button", { type: "button", class: "profile-tabs__btn" + (i === 0 ? " is-active" : "") }, s.label);
      btn.onclick = () => {
        tabStrip.querySelectorAll(".profile-tabs__btn").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        bodyWrap.innerHTML = "";
        bodyWrap.appendChild(s.content);
      };
      tabStrip.appendChild(btn);
    });
    tabCard.appendChild(tabStrip);
    bodyWrap.appendChild(sections[0].content);
    tabCard.appendChild(bodyWrap);
    view.appendChild(tabCard);
  }
};
