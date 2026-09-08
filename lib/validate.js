// @ts-check
import { badRequest } from "./AppError.js";

// Small hand-rolled guards, deliberately not a validation library: they exist
// to turn client input that Postgres would reject (and surface as a confusing
// 500) into a clear 400. Adopting a schema validator is a separate decision.

// Seconds into a recording: a position, a bookmark, a note timestamp.
// null is rejected explicitly because Number(null) is 0 — without this a
// missing position would silently save as "back to the start".
export const requireSeconds = (value, name) => {
  if (value === null || value === undefined || value === "") {
    throw badRequest(`${name} is required`);
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw badRequest(`${name} must be a non-negative number`);
  }
  return Math.floor(seconds);
};

// Same, but the field may be omitted entirely (stored as NULL).
export const optionalSeconds = (value, name) =>
  value === undefined || value === null ? null : requireSeconds(value, name);

// The largest value an INT4 column holds. Every id in this schema is SERIAL,
// which is INT4 — so a number above this is not "an id we do not have", it is a
// value the column cannot store, and Postgres answers "value out of range for
// type integer". That surfaces as a 500, which is the same confusing failure the
// non-numeric case was already guarded against. Exported because the route-param
// guard needs the identical bound: an id can arrive in the path or in the body,
// and guarding only one door leaves the other open.
export const PG_INT_MAX = 2147483647;

// A foreign key coming from the client. Postgres would reject a non-numeric id
// with "invalid input syntax for integer", and one over PG_INT_MAX with an
// out-of-range error.
export const optionalId = (value, name) => {
  if (value === undefined || value === null) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > PG_INT_MAX) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return id;
};

// The largest list of ids a single request may carry. Nothing here is a
// pagination boundary — it is the point past which a request stops being a user
// action and starts being a way to make the server build a very large array
// from a very small body. A notebook of a thousand notes is already far past
// anything a person scrolls through by hand.
export const MAX_ID_LIST = 1000;

// An ORDERED list of ids — the notebook's drag-to-reorder sends one per drop.
//
// Duplicates are rejected rather than tolerated. Postgres would accept them and
// update the same row twice with two different positions, picking a winner by
// nothing in particular; a list that names a note twice is a client bug and the
// useful answer is to say so, not to store an order that depends on which
// duplicate the planner reached last.
export const requireIdList = (value, name) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(`${name} must be a non-empty array of ids`);
  }
  if (value.length > MAX_ID_LIST) {
    throw badRequest(`${name} must hold at most ${MAX_ID_LIST} ids`);
  }
  const ids = value.map((entry) => {
    const id = Number(entry);
    if (!Number.isInteger(id) || id <= 0 || id > PG_INT_MAX) {
      throw badRequest(`${name} must contain positive integers only`);
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw badRequest(`${name} must not contain the same id twice`);
  }
  return ids;
};

// How many tags one filter list may name. Not a pagination boundary and not a
// storage limit: past this a request has stopped being something a person did
// with a mouse. The taxonomy is a few hundred nodes, and each id in the list
// becomes a recursive walk of its subtree — so a caller naming all of them turns
// one URL into a few hundred tree walks, and the URL itself outgrows what
// proxies will carry.
//
// It is a cap on ONE list. Choices and exclusions are counted separately,
// because they narrow in opposite directions and a shared budget would let a
// long exclusion list refuse a perfectly ordinary choice.
export const MAX_TAG_FILTER_IDS = 20;

/**
 * A repeatable tag-id query parameter, as the archive filter sends it.
 *
 * `?tagIds=1&tagIds=2` arrives as an array and `?tagIds=1` as a bare string, so
 * both shapes have to mean the same thing; absent means "no filter" and is an
 * empty list rather than a refusal.
 *
 * Anything that is not an id is a 400 rather than a value quietly dropped, and
 * that is the point of the guard. Dropping it returns a page of results the
 * caller believes they narrowed — the same class of failure as a filter that
 * silently does nothing, and much harder to notice than an error.
 */
export const tagIdFilter = (value, name) => {
  if (value === undefined || value === null || value === "") return [];
  const raw = [].concat(value);
  // Checked before parsing, so a very long list of rubbish is refused as a long
  // list rather than as its first bad entry.
  if (raw.length > MAX_TAG_FILTER_IDS) {
    throw badRequest(`${name} must name at most ${MAX_TAG_FILTER_IDS} tags`);
  }
  const ids = raw.map((entry) => {
    const id = Number(entry);
    if (!Number.isInteger(id) || id <= 0 || id > PG_INT_MAX) {
      throw badRequest(`${name} must contain positive integers only`);
    }
    return id;
  });
  // De-duplicated rather than refused: unlike an ordered list, naming the same
  // tag twice is not ambiguous — it asks for the same subtree twice, which is
  // the same question. Refusing it would fail a filter that is merely redundant.
  return [...new Set(ids)];
};

// A short piece of free text a user typed: a bookmark's note, and anything else
// that is prose rather than a value.
//
// Bounded because it is not: `note` is TEXT with no ceiling anywhere, and the
// body parser allows 20mb — so one row could be made to hold a book. And typed,
// because a JSON object reaching pg as a parameter is a driver error surfacing
// as a 500, which is the same confusing failure the guards above exist to turn
// into a 400 that names the problem.
export const MAX_NOTE_CHARS = 2000;

export const optionalNote = (value, name) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw badRequest(`${name} must be text`);
  if (value.length > MAX_NOTE_CHARS) {
    throw badRequest(`${name} must be at most ${MAX_NOTE_CHARS} characters`);
  }
  return value;
};

// One side of a rectangle on a page, as a fraction between 0 and 1.
//
// Fractions rather than pixels because a pixel is measured at whatever zoom and
// window the reader happened to have; see migration 027. The bounds are checked
// here as well as by the CHECK constraint, so a caller gets a 400 that names the
// field instead of a driver error quoting a constraint.
export const fraction = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw badRequest(`${name} must be a fraction between 0 and 1`);
  }
  return number;
};

/**
 * The rectangle a bookmark was drawn on a page, or null.
 *
 * All four sides or none: three of them describe nothing, and storing a partial
 * rectangle would put a row in the list that cannot be drawn — the same failure
 * migration 022's constraint exists to prevent, one level down.
 */
export const optionalRect = (value, name) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be an object with x, y, w and h`);
  }
  const sides = ["x", "y", "w", "h"];
  const missing = sides.filter((side) => value[side] === undefined || value[side] === null);
  if (missing.length > 0) {
    throw badRequest(`${name} needs all of x, y, w and h — missing ${missing.join(", ")}`);
  }

  const rect = Object.fromEntries(sides.map((side) => [side, fraction(value[side], `${name}.${side}`)]));
  // A rectangle with no area cannot be seen, so it is a mark nobody can find.
  if (rect.w === 0 || rect.h === 0) {
    throw badRequest(`${name} must have a width and a height`);
  }
  return rect;
};

export const optionalBoolean = (value, name) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw badRequest(`${name} must be a boolean`);
  return value;
};

// ── Email shape ─────────────────────────────────────────────────────────────
//
// Checks that an address is SHAPED like an address. It cannot check that the
// inbox exists — only a message sent to it can, which is what the verification
// mail already does — so this is about catching the typo at the point it is
// made rather than three days later when somebody wonders why no mail arrived.
//
// ── Deliberately not RFC 5322 ───────────────────────────────────────────────
//
// The full grammar permits quoted local parts, comments in parentheses and
// bracketed IP literals. Nobody signs up with those, every regex claiming to
// implement it is wrong somewhere, and accepting them would let through strings
// that real mail servers reject anyway. What is enforced here is the shape every
// address a person actually types has.
//
// The failure mode that matters is the WRONG one to optimise against: rejecting
// a valid address locks somebody out of signing up with no way around it, while
// accepting a subtly invalid one costs a bounced verification mail. So each rule
// below is one that cannot plausibly reject a real address.

// The whole address. 254 is the practical ceiling an SMTP envelope accepts.
const EMAIL_MAX = 254;
// Before the @. 64 is the RFC limit and real servers enforce it.
const LOCAL_MAX = 64;
// Each dot-separated piece of the domain.
const LABEL_MAX = 63;

// Unicode letters are allowed in the local part: a Hebrew-speaking user may
// legitimately have one, and rejecting it would be exactly the lockout this is
// written to avoid. What is excluded is whitespace, the @ itself, and the
// characters that only appear in the quoted form nobody types.
const LOCAL_ALLOWED = /^[^\s@,;:<>()[\]\\"]+$/u;

// A domain label: letters, digits and hyphens, never starting or ending with a
// hyphen. Unicode letters permitted so an internationalised domain is not
// refused outright.
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

// The last label. Letters only and at least two of them — no real top-level
// domain is one character or contains a digit, and "user@localhost" or a bare
// "user@example" is a typo in this context rather than an address to keep.
const TLD = /^\p{L}{2,}$/u;

/**
 * Returns null when the address is usable, or a Hebrew reason when it is not.
 *
 * Returning the reason rather than a boolean is what lets the caller say what is
 * wrong. "כתובת אימייל אינה תקינה" on a missing dot in the domain is a message
 * that makes somebody retype a correct address several times.
 */
export const emailProblem = (value) => {
  if (typeof value !== "string" || value.trim() === "") return "יש להזין כתובת אימייל";

  const email = value.trim();
  if (email.length > EMAIL_MAX) return "כתובת האימייל ארוכה מדי";
  if (/\s/.test(email)) return "כתובת אימייל אינה יכולה להכיל רווחים";

  const at = email.split("@");
  if (at.length < 2) return 'כתובת אימייל חייבת להכיל @';
  if (at.length > 2) return "כתובת אימייל יכולה להכיל @ אחד בלבד";

  const [local, domain] = at;

  if (local.length === 0) return "חסר החלק שלפני ה-@";
  if (local.length > LOCAL_MAX) return "החלק שלפני ה-@ ארוך מדי";
  if (!LOCAL_ALLOWED.test(local)) return "החלק שלפני ה-@ מכיל תווים שאינם חוקיים";
  // A dot at either end, or two in a row, is invalid and is almost always a
  // typing slip rather than an intention.
  if (local.startsWith(".") || local.endsWith(".")) return "החלק שלפני ה-@ אינו יכול להתחיל או להסתיים בנקודה";
  if (local.includes("..")) return "החלק שלפני ה-@ מכיל שתי נקודות רצופות";

  if (domain.length === 0) return "חסר שם הדומיין אחרי ה-@";
  if (domain.includes("..")) return "שם הדומיין מכיל שתי נקודות רצופות";
  if (domain.startsWith(".") || domain.endsWith(".")) return "שם הדומיין אינו יכול להתחיל או להסתיים בנקודה";

  const labels = domain.split(".");
  // This is the check that catches the most common real mistake by a wide
  // margin: "name@gmail" — the sender simply stopped typing.
  if (labels.length < 2) return "חסרה סיומת בדומיין (למשל ‎.com‎)";

  for (const label of labels) {
    if (label.length === 0 || label.length > LABEL_MAX) return "שם הדומיין אינו תקין";
    if (!LABEL.test(label)) return "שם הדומיין מכיל תווים שאינם חוקיים";
  }

  if (!TLD.test(labels[labels.length - 1])) return "סיומת הדומיין אינה תקינה (למשל ‎.com‎, ‎.co.il‎)";

  return null;
};

/** The throwing form, for the paths that turn a bad address into a 400. */
export const assertUsableEmail = (value) => {
  const problem = emailProblem(value);
  if (problem) throw badRequest(problem);
};
