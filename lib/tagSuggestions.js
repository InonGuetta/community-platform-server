// @ts-check

// Guessing what an item is about, from what it is called.
//
// ── Where this rule comes from ──────────────────────────────────────────────
//
// It is the procedure a person actually followed over this archive's nineteen
// items, written down. Read the title; if it names something the taxonomy
// already has, take that; if it names a SUBJECT the taxonomy words differently,
// map it; if it says nothing about content, suggest nothing. Everything below is
// one of those three, and the mistakes that procedure made by hand are the
// reason two of the rules are shaped the way they are.
//
// ── What it is NOT ──────────────────────────────────────────────────────────
//
// It does not read the media. A title is a weak signal — "לעשות חיים" says
// nothing about content — and no amount of matching turns it into a strong one.
// The transcript is the strong signal, and the LLM tagging in the PRD (ARCH-4)
// is what will use it. Until then this is a first guess offered to a person who
// knows the answer, which is why every suggestion carries the reason it was made
// and why nothing here is ever applied without being confirmed.

// The most tags to offer at once. More than a handful stops being a suggestion
// and becomes a list to audit — and the item may carry only eight in total.
const SUGGESTION_LIMIT = 5;

// Hebrew glues its prepositions to the word. Without stripping them "בבראשית"
// and "לפרשת" match nothing, which is most of how people actually write titles.
const PREFIXES = ["ה", "ו", "ב", "כ", "ל", "מ", "ש"];

// The words that say what KIND of thing follows, and therefore which branch to
// prefer. This is the fix for the one error the hand-tagging made: "תורה תמימה
// דברים" is a commentary on the BOOK and was filed under the parasha of the same
// name, because five names in this taxonomy exist twice — once as a book and
// once as a section inside it. A title that says "פרשת" means the deeper node; a
// title that says nothing means the shallower one.
const DEEPER_MARKERS = ["פרשת", "פרשה"];
const SHALLOWER_MARKERS = ["ספר", "חומש", "מסכת"];

/**
 * Subjects the taxonomy words differently from the way people title a shiur.
 *
 * Every entry is a leap a person made by hand: "חשבון נפש" is the practice, and
 * the heading it lives under is "תשובה". Kept as an explicit table rather than
 * inferred, because a wrong leap files a shiur where nobody will look for it —
 * and a table can be argued with, which a similarity score cannot.
 *
 * Matched against the tag's NAME, so it survives the ids changing between
 * environments. Where a name occurs twice, `under` names an ancestor to
 * disambiguate.
 */
const SUBJECTS = [
  { words: ["חשבון נפש", "חשבון הנפש"], tag: "תשובה" },
  { words: ["השקפה", "אקטואליה", "לאומיות", "ציונות", "מדינה", "עם ישראל"], tag: "אמונה והשקפה" },
  { words: ["ישועה", "ישועת", "בטחון", "ביטחון"], tag: "אמונה ובטחון", under: "מוסר וחסידות" },
  { words: ["חיזוק", "התמודדות", "כוחות"], tag: "חיזוק כללי" },
  { words: ["כיבוד הורים", "כיבוד אב ואם"], tag: "כבוד הבריות" },
  { words: ["לשון הרע", "שמירת הלשון"], tag: "לשון הרע" },
  { words: ["צדקה", "חסד", "נתינה"], tag: "צדקה וחסד" },
  { words: ["שלום בית"], tag: "שלום בית", under: "הבית היהודי" },
  { words: ["חינוך", "ילדים", "נוער"], tag: "חינוך ילדים" },
  { words: ["תפילה", "תפילת"], tag: "תפילה" },
  { words: ["פרנסה", "כלכלה", "כלכלת"], tag: "כלכלת הבית" },
  { words: ["אבלות", "שכול", "נפטר"], tag: "שכול ואבלות" },
  { words: ["חתונה", "נישואין", "כלה", "חתן"], tag: "חתונה ונישואין" },
];

const normalise = (value) =>
  String(value || "")
    // Punctuation a title carries around a name — the quote inside תנ"ך is part
    // of the name and must survive, so only the separators go.
    .replace(/[.,;:!?()[\]{}"'–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The forms of a word that may stand for the same word: as written, and with a
// glued preposition taken off.
//
// BOTH, never only the stripped one. Stripping alone turned "בהר" — a parasha
// whose name begins with the letter that also means "in" — into "הר", and the
// whole of ויקרא went untagged because of it. A prefix cannot be told from a
// first letter, so the answer is to try it both ways rather than to guess.
const formsOf = (word) => {
  const forms = [word];
  for (const prefix of PREFIXES) {
    if (word.length > prefix.length + 1 && word.startsWith(prefix)) forms.push(word.slice(prefix.length));
  }
  return forms;
};

// Hebrew is written with and without its vowel letters — "כי תבא" and "כי תבוא"
// are the same parasha, and a title uses whichever the person typed. Dropping ו
// and י from both sides makes them the same string. Used only as a fallback,
// and only for names long enough that the skeleton still identifies them:
// collapsing short words this way makes everything look like everything.
const skeleton = (value) => value.replace(/[וי]/g, "");

/**
 * Whether a tag's name appears in the text as a word rather than inside one.
 *
 * "בא" is a parasha and also the commonest verb in Hebrew, so a bare substring
 * search files half the archive under it. Short names are therefore only matched
 * when something in the title says a name is coming — which is exactly how a
 * person reads "פרשת בא" and does not read "בא לידי ביטוי".
 */
const matchesWord = (word, part) => {
  if (formsOf(word).includes(part)) return true;
  // The spelling fallback, for names that are still themselves without their
  // vowel letters. Held to words of nearly the same length, because the collapse
  // is blunt: without that guard "בחוקותי" and "חוקת" — two different parashot
  // in two different books — come out as the same three letters, and every
  // shiur on one is offered the other.
  if (part.length < 4) return false;
  return formsOf(word).some(
    (form) =>
      Math.abs(form.length - part.length) <= 1 &&
      skeleton(form) === skeleton(part) &&
      skeleton(part).length >= 3
  );
};

const mentions = (words, name) => {
  const parts = normalise(name).split(" ");
  if (parts.length > 1) {
    // A phrase matches as a phrase, in order.
    for (let i = 0; i + parts.length <= words.length; i += 1) {
      if (parts.every((part, j) => matchesWord(words[i + j], part))) return i;
    }
    return -1;
  }
  return words.findIndex((word) => matchesWord(word, parts[0]));
};

const hasMarkerBefore = (words, index, markers) =>
  index > 0 && formsOf(words[index - 1]).some((form) => markers.includes(form));

/**
 * Tags worth offering for an item, most confident first.
 *
 * Each carries the reason it was chosen, because a suggestion nobody can check
 * is a suggestion people either accept blindly or ignore entirely.
 *
 * @param {{ title?: string, description?: string }} item
 * @param {Array<{ id: number, name: string, parent_id: number|null }>} tags
 * @param {{ limit?: number }} [options]
 */
export const suggestTags = (item, tags = [], options = {}) => {
  const limit = options.limit ?? SUGGESTION_LIMIT;
  const text = normalise(`${item?.title || ""} ${item?.description || ""}`);
  const words = text.split(" ").filter(Boolean);
  if (words.length === 0 || tags.length === 0) return [];

  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const ancestors = (tag) => {
    const chain = [];
    let cur = byId.get(tag.parent_id ?? -1);
    while (cur) {
      chain.unshift(cur);
      cur = byId.get(cur.parent_id ?? -1);
    }
    return chain;
  };
  const pathOf = (tag) => ancestors(tag).map((a) => a.name).join(" ← ");
  const depthOf = (tag) => ancestors(tag).length;

  /** @type {Map<number, { id: number, name: string, path: string, reason: string, score: number }>} */
  const found = new Map();
  const offer = (tag, score, reason) => {
    const existing = found.get(tag.id);
    if (existing && existing.score >= score) return;
    found.set(tag.id, { id: tag.id, name: tag.name, path: pathOf(tag), reason, score });
  };

  // ── 1. The taxonomy's own words, appearing in the title ────────────────
  for (const tag of tags) {
    const at = mentions(words, tag.name);
    if (at === -1) continue;

    // A one- or two-letter name is a word before it is a tag. Only a marker —
    // "פרשת בא" — makes it a name.
    const short = normalise(tag.name).replace(/\s/g, "").length <= 2;
    const marked = hasMarkerBefore(words, at, [...DEEPER_MARKERS, ...SHALLOWER_MARKERS]);
    if (short && !marked) continue;

    offer(tag, marked ? 100 : 80, marked ? `הכותרת אומרת "${words[at - 1]} ${tag.name}"` : `השם "${tag.name}" מופיע בכותרת`);
  }

  // ── 2. The same name in two places ─────────────────────────────────────
  //
  // Where a name occurs twice — a book and a section inside it — the title says
  // which was meant, and when it says nothing the broader one is the safer
  // guess: a commentary on the whole book filed under one parasha is wrong in a
  // way nobody notices, while the reverse is merely coarse.
  const byName = new Map();
  for (const suggestion of found.values()) {
    const list = byName.get(suggestion.name) || [];
    list.push(suggestion);
    byName.set(suggestion.name, list);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const at = mentions(words, name);
    const wantsDeeper = hasMarkerBefore(words, at, DEEPER_MARKERS);
    const sorted = [...list].sort(
      (a, b) => depthOf(byId.get(a.id)) - depthOf(byId.get(b.id))
    );
    const keep = wantsDeeper ? sorted[sorted.length - 1] : sorted[0];
    for (const suggestion of list) if (suggestion.id !== keep.id) found.delete(suggestion.id);
    keep.reason = wantsDeeper
      ? `${keep.reason} — ופרשה, לפי המילה "פרשת"`
      : `${keep.reason} — הרחב מבין השניים, כי הכותרת לא אמרה "פרשת"`;
  }

  // ── 3. Subjects the taxonomy words differently ─────────────────────────
  for (const subject of SUBJECTS) {
    const hit = subject.words.find((word) => mentions(words, word) !== -1);
    if (!hit) continue;
    const candidates = tags.filter(
      (tag) =>
        tag.name === subject.tag &&
        (!subject.under || ancestors(tag).some((a) => a.name === subject.under))
    );
    // A tag the taxonomy no longer holds is simply not offered: the table is
    // maintained by hand and the tree changes without it.
    for (const tag of candidates.slice(0, 1)) {
      offer(tag, 50, `"${hit}" בכותרת — הנושא הקרוב ביותר בעץ`);
    }
  }

  return [...found.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "he"))
    .slice(0, limit)
    .map(({ score, ...rest }) => rest);
};
