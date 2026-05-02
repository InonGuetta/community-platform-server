import Stripe from "stripe";
import * as servicesDonations from "../services/servicesDonations.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const createIntent = async (req, res) => {
  try {
    const { amountCents, currency = "ILS", type } = req.body;
    if (!amountCents || !type) return res.status(400).json({ message: "amountCents and type are required" });
    const result = await servicesDonations.createPaymentIntent(req.user.id, amountCents, currency, type);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
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
  try {
    const donations = await servicesDonations.getDonationsByUser(req.user.id);
    res.status(200).json(donations);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
