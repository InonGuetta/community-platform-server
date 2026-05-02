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

export const updateDonationStatus = async (stripePaymentIntent, status) => {
  const result = await pool.query(
    "UPDATE donations SET status=$1 WHERE stripe_payment_intent=$2 RETURNING *",
    [status, stripePaymentIntent]
  );
  if (result.rows.length === 0) throw new Error("Donation not found");
  return result.rows[0];
};

export const getDonationsByUser = async (userId) => {
  const result = await pool.query(
    "SELECT * FROM donations WHERE donor_id=$1 ORDER BY created_at DESC",
    [userId]
  );
  return result.rows;
};
