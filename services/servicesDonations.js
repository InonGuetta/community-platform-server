import Stripe from "stripe";
import { pool } from "../db/pool.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const createPaymentIntent = async (donorId, amountCents, currency, type) => {
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: currency.toLowerCase(),
    metadata: { donorId: String(donorId), type },
  });

  const result = await pool.query(
    `INSERT INTO donations (donor_id, amount_cents, currency, type, stripe_payment_intent, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
    [donorId, amountCents, currency, type, paymentIntent.id]
  );

  return { donation: result.rows[0], clientSecret: paymentIntent.client_secret };
};

// Returns the updated row, or null when nothing was applied — either the
// payment intent is unknown to us, or the donation is already completed.
//
// `status <> 'completed'` makes this safe to call more than once and guards the
// ordering hazard: Stripe can redeliver an event, and a delayed
// payment_intent.payment_failed arriving after a success must not flip a paid
// donation back to failed. Not throwing is deliberate — see the webhook
// controller for why a missing donation must not become an error.
export const updateDonationStatus = async (stripePaymentIntent, status) => {
  const result = await pool.query(
    `UPDATE donations SET status=$1
     WHERE stripe_payment_intent=$2 AND status <> 'completed'
     RETURNING *`,
    [status, stripePaymentIntent]
  );
  return result.rows[0] || null;
};

export const getDonationsByUser = async (userId) => {
  const result = await pool.query(
    "SELECT * FROM donations WHERE donor_id=$1 ORDER BY created_at DESC",
    [userId]
  );
  return result.rows;
};
