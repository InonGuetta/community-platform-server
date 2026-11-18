// @ts-check
// A notification worded as an SMS (PRD AUTH-13) — the short sibling of
// lib/mailer.js → notificationEmail, from the same type and payload, in the
// recipient's language (server locales, sms.notify.*).
//
// Short on purpose: a provider bills per segment, and a Hebrew segment is 70
// characters (lib/sms.js → segmentsOf). One sentence and one link to the page
// it is about; a long title is cut, down to TITLE_MIN characters, to keep the
// message within MAX_SEGMENTS. Only the title is cut: a message still longer
// than that (a very long CLIENT_URL) goes as it is, a segment more, rather than
// losing its date or its link. Only the types an SMS category holds have a
// wording; test/smsNotifications.test.js holds each of them, in every language,
// to MAX_SEGMENTS with a long title.
import { env } from "./env.js";
import { forLocale, intlLocaleOf } from "./i18n.js";
import { segmentsOf } from "./sms.js";

export const MAX_SEGMENTS = 2;
const TITLE_MIN = 12;

// When, short: "יום ה׳, 20 בנוב׳, 19:30" rather than the mail's full date.
/** @param {string} iso @param {string | null} locale */
const shortWhen = (iso, locale) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(intlLocaleOf(locale), {
    timeZone: "Asia/Jerusalem", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
};

/**
 * The wording key, its title-like value (the one part that may be cut), the
 * other values, and the page to link to — or null for a type no SMS carries.
 * @param {string} type @param {Record<string, any>} p @param {(k: string) => string} t
 * @param {string | null} locale the reader's, for the date
 */
const partsOf = (type, p, t, locale) => {
  const lesson = `${env.clientUrl}/media/${encodeURIComponent(String(p.mediaId ?? ""))}`;
  switch (type) {
    case "session_scheduled":
    case "session_reminder":
    case "session_starting":
      return {
        key: `sms.notify.${type}`,
        title: p.title || t("mail.notify.session.defaultTitle"),
        values: { when: p.startsAt ? shortWhen(p.startsAt, locale) : "" },
        link: `${env.clientUrl}/sessions`,
      };
    case "processing_done":
    case "processing_error":
      return { key: `sms.notify.${type}`, title: p.title || t("mail.notify.processing.lesson"), values: {}, link: lesson };
    case "course_join_approved":
    case "course_join_rejected":
      return {
        key: `sms.notify.${type}`, title: p.courseTitle || t("mail.notify.join.course"), values: {}, link: `${env.clientUrl}/my-courses`,
      };
    default:
      return null;
  }
};

/** @param {string} text @param {number} max */
const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`);

/**
 * The SMS for one notification, or null when its type is not sent by SMS.
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {string | null} locale the recipient's
 * @returns {string | null}
 */
export const notificationSms = (type, payload = {}, locale = null) => {
  const { t } = forLocale(locale);
  const parts = partsOf(type, /** @type {Record<string, any>} */ (payload), t, locale);
  if (!parts) return null;
  const compose = (title) => `${t(parts.key, { ...parts.values, title })}\n${parts.link}`;

  // The longest title that keeps the message within MAX_SEGMENTS.
  let title = String(parts.title);
  let text = compose(title);
  while (segmentsOf(text).segments > MAX_SEGMENTS && title.length > TITLE_MIN) {
    title = cut(title, title.length - 4);
    text = compose(title);
  }
  return text;
};
