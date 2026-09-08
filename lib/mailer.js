// @ts-check
// Sending mail, and behaving sensibly on the many machines that cannot.
//
// This is the first outbound channel the platform has had, and it arrives
// carrying the two features that need it — password reset and email
// verification. Both are useless if the message does not go out, and both must
// not take the server down when SMTP is unconfigured, which is the normal state
// of every development machine and every test run.
//
// So it follows lib/storage.js's shape rather than lib/env.js's: `smtpConfigured()`
// asks whether values were SUPPLIED, and the send path degrades instead of
// throwing. What it degrades TO is the important part — see below.
import nodemailer from "nodemailer";
import { logger } from "./logger.js";
import { env } from "./env.js";

// Reads process.env directly, deliberately, for the same reason s3Configured
// does: this asks whether a value was supplied, and going through a getter that
// carries a default would report mail as configured on a machine with nothing
// set — then fail per-message, at the worst possible moment.
export const smtpConfigured = () => !!(
  process.env.SMTP_HOST &&
  process.env.SMTP_PORT &&
  process.env.MAIL_FROM
);

// Built once and reused. nodemailer pools connections itself, and constructing a
// transport per message is how a burst of resets turns into a burst of TCP
// handshakes.
let transport = null;
const getTransport = () => {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      // Implicit TLS on 465, STARTTLS everywhere else — the convention every
      // provider follows, so it does not need its own variable.
      secure: Number(process.env.SMTP_PORT) === 465,
      // Auth is optional: a local relay or a container-network mail service
      // often has none, and sending `auth: { user: undefined }` makes nodemailer
      // attempt a login that then fails.
      ...(process.env.SMTP_USER
        ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
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
export const sendMail = async ({ to, subject, text, html }) => {
  if (!smtpConfigured()) {
    logInstead(to, subject, text);
    return false;
  }
  try {
    await getTransport().sendMail({ from: process.env.MAIL_FROM, to, subject, text, html });
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
// Hebrew, because that is the language of every user-facing string in this
// application. Plain text alongside the HTML so a client that refuses HTML — and
// the development log above — still shows something readable.
//
// The links are built from env.clientUrl, the same value CORS and the OAuth
// redirect use, so a deployment that moves the front end does not have to
// remember this file.

export const sendPasswordResetEmail = (to, token) => {
  const link = `${env.clientUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return sendMail({
    to,
    subject: "איפוס סיסמה",
    text:
      `התקבלה בקשה לאיפוס הסיסמה בחשבונך.\n\n` +
      `לאיפוס, פתח את הקישור הבא:\n${link}\n\n` +
      `הקישור תקף לשעה אחת ולשימוש אחד בלבד.\n` +
      `אם לא ביקשת לאפס סיסמה, אפשר להתעלם מהודעה זו — דבר לא השתנה בחשבון.`,
    html:
      `<div dir="rtl" style="font-family:sans-serif;line-height:1.7">
        <p>התקבלה בקשה לאיפוס הסיסמה בחשבונך.</p>
        <p><a href="${link}">לחץ כאן לאיפוס הסיסמה</a></p>
        <p>הקישור תקף לשעה אחת ולשימוש אחד בלבד.</p>
        <p style="color:#666">אם לא ביקשת לאפס סיסמה, אפשר להתעלם מהודעה זו — דבר לא השתנה בחשבון.</p>
      </div>`,
  });
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
export const sendDonationReceiptEmail = (to, { amountCents, currency, donationId, at }) => {
  const amount = formatAmount(amountCents, currency);
  const when = new Date(at ?? Date.now()).toLocaleDateString("he-IL");
  return sendMail({
    to,
    subject: `אישור על קבלת תרומה — ${amount}`,
    text:
      `תודה על תרומתך.\n\n` +
      `סכום: ${amount}\nתאריך: ${when}\nמספר אסמכתא: ${donationId}\n\n` +
      `הודעה זו היא אישור על קבלת התרומה ואינה קבלה לצורכי מס.`,
    html:
      `<div dir="rtl" style="font-family:sans-serif;line-height:1.7">
        <p>תודה על תרומתך.</p>
        <table style="border-collapse:collapse">
          <tr><td style="padding:4px 12px 4px 0"><b>סכום</b></td><td>${amount}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>תאריך</b></td><td>${when}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>אסמכתא</b></td><td>${donationId}</td></tr>
        </table>
        <p style="color:#666">הודעה זו היא אישור על קבלת התרומה ואינה קבלה לצורכי מס.</p>
      </div>`,
  });
};

export const sendVerificationEmail = (to, token) => {
  const link = `${env.clientUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return sendMail({
    to,
    subject: "אימות כתובת אימייל",
    text:
      `ברוך הבא.\n\nלאימות כתובת האימייל, פתח את הקישור הבא:\n${link}\n\n` +
      `הקישור תקף ל-24 שעות.`,
    html:
      `<div dir="rtl" style="font-family:sans-serif;line-height:1.7">
        <p>ברוך הבא.</p>
        <p><a href="${link}">לחץ כאן לאימות כתובת האימייל</a></p>
        <p>הקישור תקף ל-24 שעות.</p>
      </div>`,
  });
};

// The answer to a role request — granted or refused.
//
// One function for both outcomes rather than two, because they are the same
// message with a different verdict, and splitting them is how the refusal ends
// up without the courtesy the grant has.
//
// A refusal names the reason when the admin gave one. Without it the recipient
// gets "no" and no way to act on it, which produces a second application that
// will be refused for the same unstated reason.
const ROLE_NAMES = { lecturer: "מרצה", admin: "מנהל" };

// `reason` defaults rather than being required: an approval has none, and
// without the default the checker makes every caller pass an explicit null.
export const sendRoleDecisionEmail = (to, { approved, role, reason = null }) => {
  const roleName = ROLE_NAMES[role] || role;

  if (approved) {
    return sendMail({
      to,
      subject: `בקשתך אושרה — הרשאת ${roleName}`,
      text:
        `בקשתך להרשאת ${roleName} אושרה.\n\n` +
        `ההרשאה כבר פעילה בחשבונך — אין צורך להתנתק ולהתחבר מחדש.\n${env.clientUrl}`,
      html:
        `<div dir="rtl" style="font-family:sans-serif;line-height:1.7">
          <p>בקשתך להרשאת <strong>${roleName}</strong> אושרה.</p>
          <p>ההרשאה כבר פעילה בחשבונך — אין צורך להתנתק ולהתחבר מחדש.</p>
          <p><a href="${env.clientUrl}">כניסה לפלטפורמה</a></p>
        </div>`,
    });
  }

  const because = reason ? `\n\nסיבה: ${reason}` : "";
  return sendMail({
    to,
    subject: `בקשתך להרשאת ${roleName} לא אושרה`,
    text:
      `בקשתך להרשאת ${roleName} לא אושרה.${because}\n\n` +
      `חשבונך פעיל וממשיך לעבוד כרגיל כתלמיד.\n${env.clientUrl}`,
    html:
      `<div dir="rtl" style="font-family:sans-serif;line-height:1.7">
        <p>בקשתך להרשאת <strong>${roleName}</strong> לא אושרה.</p>
        ${reason ? `<p>סיבה: ${reason}</p>` : ""}
        <p>חשבונך פעיל וממשיך לעבוד כרגיל כתלמיד.</p>
        <p><a href="${env.clientUrl}">כניסה לפלטפורמה</a></p>
      </div>`,
  });
};
