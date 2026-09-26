// Shared blood-group parsing/formatting logic. This is the SINGLE SOURCE OF
// TRUTH for src/worker.js (the og:title/description override for /seek?bg=
// links) and src/handlers/telegram.js (extracting a blood group out of a
// Telegram message).
//
// This is NOT imported by public/js/views-public.js - that file is a plain
// browser <script> (see public/index.html), not an ES module, and this app
// ships with no bundler/build step, so a browser-side script can't import a
// src/lib/*.js Worker module. views-public.js therefore keeps its own
// verbatim copy of normalizeBloodGroupParam / shortBloodGroupCode /
// BLOOD_GROUP_WORD_SUFFIXES - if you change the behavior of any exported
// function below, mirror the change there too (see the comment above that
// copy).

import { BLOOD_GROUPS, isValidBloodGroup } from "./util.js";

export { BLOOD_GROUPS, isValidBloodGroup };

// ---- English word-suffix table (?bg=Apositive, ?bg=Apos, "Bpositive", etc.) ----
// Checked longest-first so "POSITIVE" isn't mistaken for ending in "POS"
// before the fuller word is tried.
export const BLOOD_GROUP_WORD_SUFFIXES = [["POSITIVE", "+"], ["NEGATIVE", "-"], ["POS", "+"], ["NEG", "-"], ["P", "+"], ["N", "-"]];

function applyWordSuffixes(v) {
  for (const [word, symbol] of BLOOD_GROUP_WORD_SUFFIXES) {
    if (v.endsWith(word)) return v.slice(0, -word.length) + symbol;
  }
  return v;
}

// ?bg=<raw> query-param normalizer. A literal "+" typed in a URL's query
// string decodes to a space (not "+") per the query-string convention, so a
// hand-typed/pasted ?bg=A+ link arrives here as "A " (trailing space) - that
// trailing space is trimmed back into "+" before validating. Also accepts
// the spelled-out word suffixes above. Exact port of the original in
// views-public.js / worker.js.
export function normalizeBloodGroupParam(raw) {
  if (!raw) return null;
  let v = raw.trim();
  if (raw.endsWith(" ") && !v.endsWith("+") && !v.endsWith("-")) v += "+";
  v = applyWordSuffixes(v.toUpperCase());
  return v;
}

// Reverse of normalizeBloodGroupParam - shortest possible ?bg= code for a
// canonical group (e.g. "O+" -> "op", "AB-" -> "abn").
export function shortBloodGroupCode(g) {
  if (!g) return "";
  return g.endsWith("+") ? g.slice(0, -1).toLowerCase() + "p" : g.slice(0, -1).toLowerCase() + "n";
}

// ================= Telegram bot freeform-text extraction (plan §2) =================

// Bengali letter names, longest-first so "এবি" (AB) isn't matched as a bare
// "এ" (A) with a stray "বি" left dangling.
const BENGALI_LETTER_MAP = [["এবি", "AB"], ["বি", "B"], ["ও", "O"], ["এ", "A"]];

// Bengali phonetic renderings of "positive"/"negative" (e.g. "বি পজিটিভ").
const BENGALI_WORD_SUFFIXES = [["পজিটিভ", "+"], ["নেগেটিভ", "-"]];

// Bare letter tokens (English or Bengali) that only become a full group once
// combined with a following positive/negative word - "B" + "positive",
// "বি" + "পজিটিভ", "এবি" + "নেগেটিভ".
const BARE_LETTER_TOKENS = new Set(["A", "B", "O", "AB", "এ", "বি", "ও", "এবি"]);

function stripPunctuation(word) {
  return word.replace(/^[.,!?;:।"'‘’“”]+|[.,!?;:।"'‘’“”]+$/g, "");
}

// Normalizes ONE already-split, punctuation-stripped token into a canonical
// A+/A-/B+/B-/O+/O-/AB+/AB- group, or null if it isn't recognizably one.
// Handles, on top of everything normalizeBloodGroupParam already handles:
//   - parens around the symbol/word:      B(+), A(-ve), বি(-)
//   - a trailing "ve" after the symbol:   B+ve, O-ve, A(+ve)
//   - Bengali letter name + symbol/word:  এ+, বি-, এবি(+), ওNegative
export function normalizeBloodGroupToken(raw) {
  if (!raw) return null;
  // Parens carry no meaning of their own here - "A(+ve)" and "A+ve" resolve
  // the same way, so drop them before anything else.
  let v = raw.replace(/[()]/g, "").trim();
  if (!v) return null;

  // Bengali letter name -> English letter, longest-first.
  for (const [bn, en] of BENGALI_LETTER_MAP) {
    if (v.startsWith(bn)) { v = en + v.slice(bn.length); break; }
  }
  // Bengali positive/negative word -> symbol, wherever it lands in the token.
  for (const [bn, symbol] of BENGALI_WORD_SUFFIXES) {
    if (v.endsWith(bn)) { v = v.slice(0, -bn.length) + symbol; break; }
  }

  v = v.toUpperCase();
  // "B+VE" / "O-VE" -> "B+" / "O-". Anchored to "right after the symbol" so
  // this never eats into an unrelated trailing word.
  v = v.replace(/^([A-Z]{1,2})([+-])VE$/, "$1$2");
  v = applyWordSuffixes(v);

  return isValidBloodGroup(v) ? v : null;
}

// Scans free text (Bengali/English mixed) for the FIRST recognizable blood
// group, per plan §2.2 rule 2: try each token alone, then try it glued to
// the very next token (covers "B positive" / "বি পজিটিভ" arriving as two
// separate words). Returns a canonical group, or null if none is found.
export function extractBloodGroupFromText(text) {
  if (!text) return null;
  const tokens = text.split(/\s+/).map(stripPunctuation).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const single = normalizeBloodGroupToken(tokens[i]);
    if (single) return single;
    if (i + 1 < tokens.length && BARE_LETTER_TOKENS.has(tokens[i].toUpperCase())) {
      const combined = normalizeBloodGroupToken(tokens[i] + tokens[i + 1]);
      if (combined) return combined;
    }
  }
  return null;
}

// True if the text contains a generic blood-related word with no specific
// group attached (plan §2.2 rule 3 - triggers the all-groups summary).
export function containsGenericBloodWord(text) {
  return /রক্ত|blood/i.test(text || "");
}
