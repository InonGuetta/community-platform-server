// @ts-check
// Sending mail, and behaving sensibly on the many machines that cannot.
//
// This is the first outbound channel the platform has had, and it arrives
// carrying the two features that need it — password reset and email
// verification. Both are useless if the message does not go out, and both must
// not take the server down when SMTP is unconfigured, which is the normal state
// of every development machine and every test run.
//
// So, like S3 in lib/storage.js, `smtpConfigured()` asks whether values were
// SUPPLIED, and the send path degrades instead of throwing. What it degrades TO
// is the important part — see below.
import { parseStoredReason } from "./AppError.js";
import nodemailer from "nodemailer";
import { logger } from "./logger.js";
import { env } from "./env.js";
import { escapeHtml } from "./html.js";
import { forLocale, intlLocaleOf } from "./i18n.js";

// Whether the values were SUPPLIED, as s3Configured asks it — see the note on
// env.smtpConfigured.
export const smtpConfigured = () => env.smtpConfigured;

// Built once and reused. nodemailer pools connections itself, and constructing a
// transport per message is how a burst of resets turns into a burst of TCP
// handshakes.
let transport = null;
const getTransport = () => {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      // Implicit TLS on 465, STARTTLS everywhere else — the convention every
      // provider follows, so it does not need its own variable.
      secure: env.smtpPort === 465,
      // Auth is optional: a local relay or a container-network mail service
      // often has none, and sending `auth: { user: undefined }` makes nodemailer
      // attempt a login that then fails.
      ...(env.smtpUser
        ? { auth: { user: env.smtpUser, pass: env.smtpPassword } }
        : {}),
    });
  }
  return transport;
};

// What an unconfigured machine does instead of sending.
//
// NOT a silent no-op. A password reset that quietly goes nowhere is
// indistinguishable, from the developer's side, from one that is broken — and
// the link is the only way to continue the flow. So the whole message goes to
// the log at warn level, where it can be read and the link followed by hand.
//
// That is safe here and would not be in production, which is why it says so:
// the log is the one place this content is allowed to appear, and only because
// production is expected to have SMTP configured. If it does not, this line is
// the warning that it does not.
const logInstead = (to, subject, text) => {
  logger.warn(
    `[mail] SMTP is not configured — not sending "${subject}" to ${to}. ` +
    `The message follows so the flow can be completed by hand in development:\n${text}`
  );
};

// Best-effort by contract. Every caller is in the middle of an HTTP request that
// has already succeeded at the thing the user asked for — the reset row is
// written, the account is created — and a mail server being down must not turn
// that into a 500 that tells them to try again, because trying again would
// create a second reset token or fail on a taken email.
//
// Returns whether it went out, for the callers that want to log it.
/**
 * @param {{ to: string, subject: string, text: string, html?: string,
 *           attachments?: object[], headers?: Record<string, string> }} message
 */
export const sendMail = async ({ to, subject, text, html, attachments, headers }) => {
  if (!smtpConfigured()) {
    logInstead(to, subject, text);
    return false;
  }
  try {
    await getTransport().sendMail({ from: env.mailFrom, to, subject, text, html, attachments, headers });
    logger.info(`[mail] sent "${subject}"`);
    return true;
  } catch (err) {
    // The address is NOT logged. It is the same PII the query parameters are
    // withheld for — see db/pool.js — and a failure line is exactly the sort
    // that gets pasted into a bug report.
    logger.error(`[mail] could not send "${subject}": ${err.message}`);
    return false;
  }
};

// ── The messages ────────────────────────────────────────────────────────────
//
// In the RECIPIENT's language — users.locale, passed by every caller — with the
// words in locales/<code>.json (lib/i18n.js) and lang/dir set on the HTML so a
// mail client lays an English mail out left to right. Plain text alongside the
// HTML so a client that refuses HTML — and the development log above — still
// shows something readable.
//
// The links are built from env.clientUrl, the same value CORS and the OAuth
// redirect use, so a deployment that moves the front end does not have to
// remember this file.

// The frame every mail's HTML sits in: the reader's language and direction.
/** @param {{ lang: string, dir: string }} words @param {string} inner */
export const mailFrame = ({ lang, dir }, inner) =>
  `<div lang="${lang}" dir="${dir}" style="font-family:sans-serif;line-height:1.7">${inner}</div>`;

/** @param {string} token @param {string|null} [locale] */
export const passwordResetEmail = (token, locale = null) => {
  const words = forLocale(locale);
  const { t } = words;
  const link = `${env.clientUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: t("mail.reset.subject"),
    text:
      `${t("mail.reset.intro")}\n\n` +
      `${t("mail.reset.open")}\n${link}\n\n` +
      `${t("mail.reset.validity")}\n` +
      t("mail.reset.ignore"),
    html: mailFrame(
      words,
      `<p>${t("mail.reset.intro")}</p>
        <p><a href="${link}">${t("mail.reset.button")}</a></p>
        <p>${t("mail.reset.validity")}</p>
        <p style="color:#666">${t("mail.reset.ignore")}</p>`
    ),
  };
};

// Written in the donor's currency rather than assuming shekels: the API accepts
// three, and a receipt that says ₪ for a euro donation is worse than one with no
// symbol at all.
const CURRENCY_SYMBOLS = { ILS: "₪", USD: "$", EUR: "€" };

const formatAmount = (amountCents, currency) => {
  const symbol = CURRENCY_SYMBOLS[String(currency).toUpperCase()] ?? "";
  return `${symbol}${(amountCents / 100).toFixed(2)}`;
};

// Confirmation that money was taken, which a donor previously received in no
// form whatsoever — not on screen, not by mail. For an organisation collecting
// donations that is an accounting problem as much as a courtesy one.
//
// Deliberately NOT called a tax receipt. That is a regulated document with
// requirements this does not meet, and calling it one would be a claim the
// platform cannot stand behind.
/**
 * @param {{ amountCents: number, currency: string, donationId: number|string, at?: string|Date, locale?: string|null }} donation
 */
export const donationReceiptEmail = ({ amountCents, currency, donationId, at, locale = null }) => {
  const words = forLocale(locale);
  const { t, dir } = words;
  const amount = formatAmount(amountCents, currency);
  const when = new Date(at ?? Date.now()).toLocaleDateString(intlLocaleOf(locale));
  // The gap between a label and its value is on the label's END side, which
  // flips with the direction (mail clients do not all know padding-inline-end).
  const cell = `padding:4px 0;padding-${dir === "rtl" ? "left" : "right"}:12px`;
  return {
    subject: t("mail.donation.subject", { amount }),
    text:
      `${t("mail.donation.thanks")}\n\n` +
      `${t("mail.donation.amount")}: ${amount}\n${t("mail.donation.date")}: ${when}\n` +
      `${t("mail.donation.reference")}: ${donationId}\n\n` +
      t("mail.donation.notTaxReceipt"),
    html: mailFrame(
      words,
      `<p>${t("mail.donation.thanks")}</p>
        <table style="border-collapse:collapse">
          <tr><td style="${cell}"><b>${t("mail.donation.amount")}</b></td><td>${amount}</td></tr>
          <tr><td style="${cell}"><b>${t("mail.donation.date")}</b></td><td>${when}</td></tr>
          <tr><td style="${cell}"><b>${t("mail.donation.referenceShort")}</b></td><td>${donationId}</td></tr>
        </table>
        <p style="color:#666">${t("mail.donation.notTaxReceipt")}</p>`
    ),
  };
};

/** @param {string} token @param {string|null} [locale] */
export const verificationEmail = (token, locale = null) => {
  const words = forLocale(locale);
  const { t } = words;
  const link = `${env.clientUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    subject: t("mail.verify.subject"),
    text: `${t("mail.verify.welcome")}\n\n${t("mail.verify.open")}\n${link}\n\n${t("mail.verify.validity")}`,
    html: mailFrame(
      words,
      `<p>${t("mail.verify.welcome")}</p>
        <p><a href="${link}">${t("mail.verify.button")}</a></p>
        <p>${t("mail.verify.validity")}</p>`
    ),
  };
};

// The answer to a role request — granted or refused.
//
// One function for both outcomes rather than two, because they are the same
// message with a different verdict, and splitting them is how the refusal ends
// up without the courtesy the grant has.
//
// A refusal names the reason when the admin gave one. Without it the recipient
// gets "no" and no way to act on it, which produces a second application that
// will be refused for the same unstated reason. The reason is what the admin
// typed — content, in whatever language they wrote it — and is escaped.
//
// `reason` defaults rather than being required: an approval has none, and
// without the default the checker makes every caller pass an explicit null.

// A role's name in the reader's language; an unknown role is shown as stored.
/** @param {(key: string) => string} t @param {string|null|undefined} role */
const roleNameOf = (t, role) => {
  const key = `mail.role.names.${role}`;
  const name = t(key);
  return name === key ? role || "" : name;
};

/**
 * @param {{ approved: boolean, role: string, reason?: string|null, locale?: string|null }} decision
 */
export const roleDecisionEmail = ({ approved, role, reason = null, locale = null }) => {
  const words = forLocale(locale);
  const { t } = words;
  const roleName = roleNameOf(t, role);
  const strong = { role: `<strong>${escapeHtml(roleName)}</strong>` };

  if (approved) {
    return {
      subject: t("mail.role.approvedSubject", { role: roleName }),
      text: `${t("mail.role.approved", { role: roleName })}\n\n${t("mail.role.active")}\n${env.clientUrl}`,
      html: mailFrame(
        words,
        `<p>${t("mail.role.approved", strong)}</p>
          <p>${t("mail.role.active")}</p>
          <p><a href="${env.clientUrl}">${t("mail.enter")}</a></p>`
      ),
    };
  }

  const because = reason ? `\n\n${t("mail.reason", { reason })}` : "";
  return {
    subject: t("mail.role.rejectedSubject", { role: roleName }),
    text: `${t("mail.role.rejected", { role: roleName })}${because}\n\n${t("mail.role.stillStudent")}\n${env.clientUrl}`,
    html: mailFrame(
      words,
      `<p>${t("mail.role.rejected", strong)}</p>
        ${reason ? `<p dir="auto">${t("mail.reason", { reason: escapeHtml(reason) })}</p>` : ""}
        <p>${t("mail.role.stillStudent")}</p>
        <p><a href="${env.clientUrl}">${t("mail.enter")}</a></p>`
    ),
  };
};

// The senders. Each builds its message above — the words, in the reader's
// language — and hands it to sendMail.

/** @param {string} to @param {string} token @param {string|null} [locale] */
export const sendPasswordResetEmail = (to, token, locale = null) => sendMail({ to, ...passwordResetEmail(token, locale) });

/** @param {string} to @param {string} token @param {string|null} [locale] */
export const sendVerificationEmail = (to, token, locale = null) => sendMail({ to, ...verificationEmail(token, locale) });

/** @param {string} to @param {Parameters<typeof donationReceiptEmail>[0]} donation */
export const sendDonationReceiptEmail = (to, donation) => sendMail({ to, ...donationReceiptEmail(donation) });

/** @param {string} to @param {Parameters<typeof roleDecisionEmail>[0]} decision */
export const sendRoleDecisionEmail = (to, decision) => sendMail({ to, ...roleDecisionEmail(decision) });

// ── Notifications ───────────────────────────────────────────────────────────
//
// The mailed half of services/servicesNotifications.js → notify(). One function
// for every type, so a type added there is worded here and nowhere else; the
// bell's wording lives in the client, for the same row.
//
// In the recipient's language, like the messages above (lib/i18n.js).
//
// Escaped (escapeHtml, lib/html.js), unlike the messages above, because these
// carry what OTHER people typed — a requester's display name, a lesson's title —
// into somebody else's inbox. A name of "<a href=…>" must arrive as text, not as
// a link that looks like it came from the platform.

// When a session begins, as the reader would say it: "יום שלישי, 3 בנובמבר
// 2026 בשעה 19:30", "Tuesday, November 3, 2026 at 7:30 PM". In Israel's zone,
// named — the server's own zone is whatever the host happens to run in.
/** @param {string} iso @param {string|null|undefined} locale */
const sessionWhen = (iso, locale) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(intlLocaleOf(locale), { timeZone: "Asia/Jerusalem", dateStyle: "full", timeStyle: "short" });
};

// Why processing failed, as the worker stored it (storedReason, lib/AppError.js):
// a code worded here, or — on a row from before codes — the Hebrew sentence it
// holds, which is shown to a Hebrew reader and to nobody else.
/** @param {(key: string, params?: Record<string, any>) => string} t @param {string} lang @param {unknown} stored */
const processingReason = (t, lang, stored) => {
  const parsed = parseStoredReason(typeof stored === "string" ? stored : null);
  if (!parsed) return null;
  if ("text" in parsed) return lang === "he" ? parsed.text : null;
  const key = `mail.reasons.${parsed.code}`;
  const words = t(key, parsed.params);
  return words === key ? null : words;
};

// Exported for the test, which checks each type is worded, escaped and in the
// reader's language. `locale` is the recipient's users.locale (deliver reads it
// in the same statement that writes the rows).
/**
 * @param {string} type
 * @param {Record<string, any>} [payload]
 * @param {string|null} [locale]
 */
export const notificationEmail = (type, payload = {}, locale = null) => {
  const p = /** @type {Record<string, any>} */ (payload);
  const words = forLocale(locale);
  const { t, lang } = words;
  const block = (lines, link, linkText) => ({
    text: `${lines.join("\n")}\n\n${link}`,
    html: mailFrame(
      words,
      `${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
        <p><a href="${link}">${escapeHtml(linkText)}</a></p>`
    ),
  });
  const lessonLink = `${env.clientUrl}/media/${encodeURIComponent(String(p.mediaId ?? ""))}`;

  switch (type) {
    case "role_request": {
      const role = roleNameOf(t, p.requestedRole);
      const who = p.displayName || p.email || t("mail.notify.someone");
      return {
        subject: t("mail.notify.roleRequest.subject", { role }),
        ...block([t("mail.notify.roleRequest.body", { role, who })], `${env.clientUrl}/users`, t("mail.notify.decideLink")),
      };
    }
    case "processing_done":
    case "processing_error": {
      const done = type === "processing_done";
      const title = p.title || t("mail.notify.processing.lesson");
      const reason = done ? null : processingReason(t, lang, p.reason);
      const lines = [
        t(done ? "mail.notify.processing.done" : "mail.notify.processing.error", { title }),
        ...(reason ? [t("mail.reason", { reason })] : []),
      ];
      return {
        subject: t(done ? "mail.notify.processing.doneSubject" : "mail.notify.processing.errorSubject", { title }),
        ...block(lines, lessonLink, t("mail.notify.processing.link")),
      };
    }
    case "session_scheduled":
    case "session_reminder":
    case "session_starting": {
      const title = p.title || t("mail.notify.session.defaultTitle");
      // The course too, when the session is held for one (PRD D8).
      const host =
        (p.hostName ? t("mail.notify.session.withHost", { name: p.hostName }) : "") +
        (p.courseTitle ? t("mail.notify.inCourse", { course: p.courseTitle }) : "");
      const when = p.startsAt ? sessionWhen(p.startsAt, locale) : "";
      const whenLine = when ? [t("mail.notify.session.when", { when })] : [];
      const subject = {
        session_scheduled: t("mail.notify.session.scheduledSubject", { title }),
        session_reminder: t("mail.notify.session.reminderSubject", { title }),
        session_starting: t("mail.notify.session.startingSubject", { title }),
      }[type];
      const lines = {
        session_scheduled: [t("mail.notify.session.scheduled", { host, title }), ...whenLine, t("mail.notify.session.calendarAttached")],
        session_reminder: [t("mail.notify.session.reminder", { host, title }), ...whenLine],
        session_starting: [t("mail.notify.session.starting", { host, title })],
      }[type];
      return { subject, ...block(lines, `${env.clientUrl}/sessions`, t("mail.notify.session.link")) };
    }
    case "new_lesson": {
      const title = p.title || t("mail.notify.newLesson.defaultTitle");
      const course = p.courseTitle ? t("mail.notify.inCourse", { course: p.courseTitle }) : "";
      // "כללי" is the creator column's stored default (migration 020), not a
      // name worth naming.
      const by = p.creatorName && p.creatorName !== "כללי" ? t("mail.notify.newLesson.by", { name: p.creatorName }) : "";
      return {
        subject: t("mail.notify.newLesson.subject", { course, title }),
        ...block([t("mail.notify.newLesson.body", { course, title, by })], lessonLink, t("mail.notify.newLesson.link")),
      };
    }
    case "course_join_request": {
      const course = p.courseTitle || t("mail.notify.join.course");
      const who = p.requesterName || t("mail.notify.someone");
      return {
        subject: t("mail.notify.join.requestSubject", { course }),
        ...block([t("mail.notify.join.request", { who, course })], `${env.clientUrl}/courses`, t("mail.notify.decideLink")),
      };
    }
    case "course_join_approved":
    case "course_join_rejected": {
      const course = p.courseTitle || t("mail.notify.join.course");
      const approved = type === "course_join_approved";
      return {
        subject: t(approved ? "mail.notify.join.approvedSubject" : "mail.notify.join.rejectedSubject", { course }),
        ...block(
          [t(approved ? "mail.notify.join.approved" : "mail.notify.join.rejected", { course })],
          `${env.clientUrl}/my-courses`,
          t("mail.notify.join.myCourses")
        ),
      };
    }
    // The number went to the account that proved it (services/servicesPhone.js).
    // The payload holds it masked, never whole.
    case "phone_moved": {
      return {
        subject: t("mail.notify.phone.subject"),
        ...block([t("mail.notify.phone.body", { phone: p.phone || "" })], `${env.clientUrl}/profile`, t("mail.notify.phone.link")),
      };
    }
    default:
      return null;
  }
};

// The unsubscribe footer, on every notification mail (NOTIF-6), and the
// List-Unsubscribe header mail clients turn into their own "unsubscribe" button.
// The link goes to the CLIENT's page, which asks before it acts: a GET that
// unsubscribed would be triggered by every link scanner that previews the mail.
// Exported for its test.
/**
 * @param {{ subject: string, text: string, html: string }} message
 * @param {string|undefined} token
 * @param {string|null} [locale]
 */
export const withUnsubscribe = (message, token, locale = null) => {
  if (!token) return message;
  const { t, lang, dir } = forLocale(locale);
  const link = `${env.clientUrl}/unsubscribe?token=${encodeURIComponent(token)}&lang=${lang}`;
  return {
    ...message,
    text: `${message.text}\n\n—\n${t("mail.unsubscribe.text", { link })}`,
    html:
      `${message.html}
      <p lang="${lang}" dir="${dir}" style="font-family:sans-serif;color:#888;font-size:12px">
        <a href="${link}" style="color:#888">${t("mail.unsubscribe.link")}</a>
      </p>`,
    headers: { "List-Unsubscribe": `<${link}>` },
  };
};

// A type with no wording here is not mailed — it still reaches the bell.
/**
 * @param {string} to
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {{ unsubscribeToken?: string, attachments?: object[], locale?: string|null }} [options]
 */
export const sendNotificationEmail = async (to, type, payload, { unsubscribeToken, attachments, locale = null } = {}) => {
  const message = notificationEmail(type, payload, locale);
  if (!message) return false;
  return sendMail({ to, ...withUnsubscribe(message, unsubscribeToken, locale), attachments });
};
