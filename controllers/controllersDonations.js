// @ts-check
import Stripe from "stripe";
import * as servicesDonations from "../services/servicesDonations.js";
import { logger } from "../lib/logger.js";
import { badRequest } from "../lib/AppError.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe caps a single charge well below this; the floor keeps out zero/negative
// amounts and the ceiling rejects obviously bogus values before they hit Stripe.
const MIN_AMOUNT_CENTS = 100; // ₪1.00
const MAX_AMOUNT_CENTS = 1_000_000; // ₪10,000.00
const ALLOWED_CURRENCIES = new Set(["ILS", "USD", "EUR"]);

export const createIntent = async (req, res) => {
  const { amountCents, currency = "ILS", type } = req.body;
  if (!type) throw badRequest("type is required");
  if (!Number.isInteger(amountCents) || amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    throw badRequest("amountCents must be a whole number between 100 and 1000000");
  }
  if (!ALLOWED_CURRENCIES.has(currency.toUpperCase())) {
    throw badRequest(`Unsupported currency: ${currency}`);
  }
  const result = await servicesDonations.createPaymentIntent(req.user.id, amountCents, currency, type);
  res.status(201).json(result);
};

export const handleWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
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
