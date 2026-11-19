import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  passwordResetEmail,
  verificationEmail,
  donationReceiptEmail,
  roleDecisionEmail,
} from "../lib/mailer.js";
import { translate, forLocale, hebrewKeys } from "../lib/i18n.js";

// The mails that are not notifications — reset, verification, the donation
// receipt, a role decision — are written in the RECIPIENT's language
// (users.locale), with lang/dir on the HTML so a mail client lays them out
// the right way round.

const ALL = () => [
  passwordResetEmail("tok", "he"),
  verificationEmail("tok", "he"),
  donationReceiptEmail({ amountCents: 1800, currency: "ILS", donationId: 7, at: "2026-11-01", locale: "he" }),
  roleDecisionEmail({ approved: true, role: "lecturer", locale: "he" }),
  roleDecisionEmail({ approved: false, role: "lecturer", reason: "חסר ניסיון", locale: "he" }),
];

test("every account mail is Hebrew, framed rtl, for a Hebrew reader", () => {
  for (const mail of ALL()) {
    assert.match(mail.subject, /[֐-׿]/);
    assert.match(mail.html, /<div lang="he" dir="rtl"/);
    assert.doesNotMatch(`${mail.subject}${mail.text}${mail.html}`, /mail\./, "a key leaked instead of its words");
  }
});

test("an English reader's mail is in English, framed ltr", () => {
  const mail = passwordResetEmail("tok", "en");
  assert.equal(mail.subject, "Reset your password");
  assert.match(mail.html, /<div lang="en" dir="ltr"/);
  assert.match(mail.html, /reset-password\?token=tok/);
  assert.doesNotMatch(`${mail.text}${mail.html}`, /[֐-׿]/, "no Hebrew in an English mail");
});

// users.locale is CHECKed, but a mail must never fail on a value it does not know.
test("an unknown or missing locale falls back to Hebrew", () => {
  for (const locale of [null, undefined, "de"]) {
    assert.match(verificationEmail("tok", locale).html, /<div lang="he" dir="rtl"/);
  }
});

// What the admin typed is content: escaped, and allowed its own direction.
test("a refusal's reason is escaped", () => {
  const mail = roleDecisionEmail({ approved: false, role: "admin", reason: "<b>no</b>", locale: "he" });
  assert.match(mail.html, /&lt;b&gt;no&lt;\/b&gt;/);
  assert.match(mail.text, /<b>no<\/b>/, "plain text is not HTML and is not escaped");
});

test("the receipt's date is formatted for the reader", () => {
  const he = donationReceiptEmail({ amountCents: 1800, currency: "EUR", donationId: 7, at: "2026-11-01T12:00:00Z", locale: "he" });
  const en = donationReceiptEmail({ amountCents: 1800, currency: "EUR", donationId: 7, at: "2026-11-01T12:00:00Z", locale: "en" });
  assert.match(he.subject, /€18\.00/);
  assert.notEqual(he.text.match(/\d+[./]\d+[./]\d+/)?.[0], undefined);
  assert.match(en.text, /11\/1\/2026/);
});

test("translate: params are filled, a missing key comes back as itself", () => {
  assert.equal(translate("he", "mail.donation.subject", { amount: "₪5.00" }), "אישור על קבלת תרומה — ₪5.00");
  assert.equal(translate("he", "mail.nothing.here"), "mail.nothing.here");
  assert.equal(forLocale("yi").dir, "rtl");
  assert.equal(forLocale("fr").dir, "ltr");
});

// Every key a mail asks for exists in Hebrew — the fallback for every language.
test("every key the mailer asks for exists in locales/he.json", () => {
  const source = readFileSync(new URL("../lib/mailer.js", import.meta.url), "utf8");
  const asked = [...source.matchAll(/\bt\("(mail\.[\w.]+)"/g)].map((m) => m[1]);
  assert.ok(asked.length > 15, "the mailer's keys were not found");
  const known = new Set(hebrewKeys());
  for (const key of asked) assert.ok(known.has(key), `${key} is missing from locales/he.json`);
});
