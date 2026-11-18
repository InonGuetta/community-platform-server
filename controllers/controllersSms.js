// @ts-check
// A reply to the platform's SMS number (lib/sms.js → verifyTwilioSignature).
// The only thing a reply can do is turn SMS off: a STOP from a verified number
// clears every SMS choice of the account holding it. Anything else is
// acknowledged and ignored — nobody reads the inbox.
import * as servicesNotifications from "../services/servicesNotifications.js";
import { accountsWithVerifiedPhone } from "../services/servicesPhone.js";
import { verifyTwilioSignature, isStopReply } from "../lib/sms.js";
import { readPhone } from "../lib/phone.js";
import { forbidden } from "../lib/AppError.js";

// An empty TwiML answer: "received, send nothing back". Twilio itself answers a
// STOP to its own numbers.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export const inbound = async (req, res) => {
  const fields = req.body && typeof req.body === "object" ? req.body : {};
  if (!verifyTwilioSignature(fields, req.get("X-Twilio-Signature"))) {
    throw forbidden("Unsigned SMS webhook");
  }
  if (isStopReply(fields.Body)) {
    const from = readPhone(fields.From);
    if ("e164" in from) {
      for (const userId of await accountsWithVerifiedPhone(from.e164)) {
        await servicesNotifications.stopSms(userId, "replied STOP");
      }
    }
  }
  res.type("text/xml").status(200).send(EMPTY_TWIML);
};
