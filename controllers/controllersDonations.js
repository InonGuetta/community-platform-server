// @ts-check
import * as servicesDonations from "../services/servicesDonations.js";
import { stripe, webhookVerifiable } from "../lib/stripeClient.js";
import { sendDonationReceiptEmail } from "../lib/mailer.js";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { badRequest, ERROR_CODES } from "../lib/AppError.js";

// Stripe caps a single charge well below this; the floor keeps out zero/negative
// amounts and the ceiling rejects obviously bogus values before they hit Stripe.
const MIN_AMOUNT_CENTS = 100; // ₪1.00
const MAX_AMOUNT_CENTS = 1_000_000; // ₪10,000.00
const ALLOWED_CURRENCIES = new Set(["ILS", "USD", "EUR"]);

// Mirrors the donation_type enum from migration 006. `type` was checked only for
// presence, so any other string travelled through Stripe's metadata and into the
// INSERT, where Postgres refused it as "invalid input value for enum" — a 500 for
// what is a plain bad request, sitting next to two fields validated strictly.
const DONATION_TYPES = new Set(["one_time", "monthly"]);

// 'monthly' is in the enum, offered by the form, and NOT yet a standing order.
//
// createPaymentIntent below builds a one-off PaymentIntent whatever the type
// says, so a donor choosing "חודשי" would be charged once while believing they
// had set up a recurring gift. That is mis-selling, and it is currently harmless
// only because nothing charges at all — the client has no Stripe Elements form,
// so no card is ever collected and no intent is ever confirmed.
//
// It is refused here rather than left to become wrong the day payments go live.
// Making it real means a Stripe Subscription, which needs a payment method
// attached to a Customer, which needs card collection — see the note in
// ARCHITECTURE.md's known-debt list. Deleting this check is the last step of
// that work, not the first.
const RECURRING_IMPLEMENTED = false;

export const createIntent = async (req, res) => {
  const { amountCents, currency = "ILS", type } = req.body ?? {};
  if (!DONATION_TYPES.has(type)) {
    throw badRequest(`type must be one of: ${[...DONATION_TYPES].join(", ")}`);
  }
  if (type === "monthly" && !RECURRING_IMPLEMENTED) {
    throw badRequest(
      "Recurring donations are not available yet",
      ERROR_CODES.RECURRING_UNAVAILABLE
    );
  }
  if (!Number.isInteger(amountCents) || amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    throw badRequest("amountCents must be a whole number between 100 and 1000000");
  }
  // The type check comes first: currency arrives from the body and is not
  // necessarily a string, and calling a string method on it threw a TypeError —
  // answering 500 from inside the very block whose job is to answer 400.
  if (typeof currency !== "string" || !ALLOWED_CURRENCIES.has(currency.toUpperCase())) {
    throw badRequest(`Unsupported currency: ${currency}`);
  }
  const result = await servicesDonations.createPaymentIntent(req.user.id, amountCents, currency, type);
  res.status(201).json(result);
};

export const handleWebhook = async (req, res) => {
  // Without a secret there is nothing to verify against, and an UNVERIFIED
  // webhook is worse than none: the body is attacker-controlled and it moves
  // money to 'completed'. Refused explicitly rather than left to fail inside the
  // SDK, so the log says what is actually wrong. checkEnv already warns at boot.
  if (!webhookVerifiable()) {
    logger.error("[webhook] refused: STRIPE_WEBHOOK_SECRET is not set, so signatures cannot be checked");
    return res.status(503).json({ message: "Webhook verification is not configured" });
  }

  const sig = req.headers["stripe-signature"];
  let event;
  try {
    // req.body is the RAW Buffer here, not parsed JSON — app.js skips the global
    // parser for this one path and the router re-parses it with express.raw().
    // Stripe signs the exact bytes, so anything that reserialises them breaks
    // verification for every event.
    event = stripe.webhooks.constructEvent(req.body, sig, env.stripeWebhookSecret);
  } catch (err) {
    return res.status(400).json({ message: `Webhook error: ${err.message}` });
  }

  const STATUS_BY_EVENT = {
    "payment_intent.succeeded": "completed",
    "payment_intent.payment_failed": "failed",
  };

  try {
    const status = STATUS_BY_EVENT[event.type];
    if (status) {
      const updated = await servicesDonations.updateDonationStatus(event.data.object.id, status);
      // No row updated: an intent we never recorded, or one already completed
      // (a redelivery). Neither is an error, and both are 200 — answering 5xx
      // would put Stripe into a retry loop over something that can never
      // succeed. Previously this threw and became a permanent retry storm.
      if (!updated) {
        logger.info(`[webhook] ${event.type} for ${event.data.object.id}: no update applied`);
      } else if (status === "completed") {
        // Sent only on the transition, which the `status <> 'completed'` in the
        // UPDATE guarantees: a redelivered success updates nothing and therefore
        // sends nothing, so a donor is not thanked three times for one gift.
        //
        // Not awaited, and failures are swallowed: a mail server being down must
        // not make this answer 5xx, because Stripe would then retry an event that
        // has already been recorded.
        sendDonationReceiptEmail(updated.donor_email, {
          amountCents: updated.amount_cents,
          currency: updated.currency,
          donationId: updated.id,
          at: updated.created_at,
        }).catch(() => {});
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    // A genuine failure — the database being unreachable, say. Here a retry is
    // exactly what we want, so this one really is a 500.
    logger.error(`[webhook] ${event.type} failed, asking Stripe to retry: ${err.message}`);
    res.status(500).json({ message: "Webhook processing failed" });
  }
};

export const getMyHistory = async (req, res) => {
  const donations = await servicesDonations.getDonationsByUser(req.user.id);
  res.status(200).json(donations);
};
