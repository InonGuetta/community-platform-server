// @ts-check
// A phone number as this platform holds it: E.164 ("+972501234567").
//
// Whatever the person typed — "050-123-4567", "+972 50 123 4567", a pasted
// number with spaces — is read with Israel as the country when it has no
// country code of its own, and accepted only when it can receive an SMS: a
// mobile number (or, where a country does not tell the two apart, as in the
// US, a number that may be one). A landline would take a code that never
// arrives.
//
// The number is personal data. It is never logged whole (maskPhone), and
// sms_usage keeps only its hash (phoneHash).
import { createHash } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export const DEFAULT_COUNTRY = "IL";
const SMS_TYPES = new Set(["MOBILE", "FIXED_LINE_OR_MOBILE"]);

/**
 * What a typed number is: { e164 } when it can receive an SMS, or
 * { problem: "invalid" | "notMobile" }.
 * @param {unknown} input
 * @returns {{ e164: string } | { problem: "invalid" | "notMobile" }}
 */
export const readPhone = (input) => {
  if (typeof input !== "string" || !input.trim() || input.length > 40) return { problem: "invalid" };
  const parsed = parsePhoneNumberFromString(input.trim(), DEFAULT_COUNTRY);
  if (!parsed || !parsed.isValid()) return { problem: "invalid" };
  const type = parsed.getType();
  if (type && !SMS_TYPES.has(type)) return { problem: "notMobile" };
  return { e164: parsed.number };
};

/** "+972•••••4567" — enough to recognise one's own number, not to read it. @param {string|null|undefined} e164 */
export const maskPhone = (e164) => {
  if (!e164) return null;
  const parsed = parsePhoneNumberFromString(e164);
  const country = parsed ? `+${parsed.countryCallingCode}` : e164.slice(0, 4);
  return `${country}${"•".repeat(Math.max(0, e164.length - country.length - 4))}${e164.slice(-4)}`;
};

/** The number's SHA-256, for counting without storing it. @param {string} e164 */
export const phoneHash = (e164) => createHash("sha256").update(e164).digest("hex");
