import Stripe from "stripe";
import * as servicesDonations from "../services/servicesDonations.js";
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

  try {
    if (event.type === "payment_intent.succeeded") {
      await servicesDonations.updateDonationStatus(event.data.object.id, "completed");
    } else if (event.type === "payment_intent.payment_failed") {
      await servicesDonations.updateDonationStatus(event.data.object.id, "failed");
    }
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getMyHistory = async (req, res) => {
  const donations = await servicesDonations.getDonationsByUser(req.user.id);
  res.status(200).json(donations);
};
