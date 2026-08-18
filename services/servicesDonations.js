// @ts-check
import { pool } from "../db/pool.js";
import { stripe } from "../lib/stripeClient.js";

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
// The donor's address rides back with the row so a receipt can be sent without a
// second query — and because the webhook is the only place that knows a payment
// just completed. Returning it here rather than looking it up in the controller
// keeps the "only services touch pool" rule intact.
export const updateDonationStatus = async (stripePaymentIntent, status) => {
  const result = await pool.query(
    `UPDATE donations d SET status=$1
     FROM users u
     WHERE d.stripe_payment_intent=$2 AND d.status <> 'completed' AND u.id = d.donor_id
     RETURNING d.*, u.email AS donor_email, u.display_name AS donor_name`,
    [status, stripePaymentIntent]
  );
  return result.rows[0] || null;
};

// ── The ledger, for whoever has to reconcile it ─────────────────────────────

// Every donation, newest first, with who made it.
//
// An admin could see a TOTAL — getStats sums completed rows — and nothing else:
// not who gave, not when, not which ones failed. That is a number you cannot
// check against Stripe, which for an organisation taking donations is the one
// thing the figure has to be good for.
//
// Bounded rather than paginated: this is a reconciliation view, and the answer to
// "more than 200 donations" is an export, not a second page. The limit is stated
// so the caller knows the list may be partial.
/** @param {{ status?: string, limit?: number }} [options] */
export const getAllDonations = async ({ status, limit = 200 } = {}) => {
  // Annotated because the array is mixed: the limit is a number and the optional
  // status filter is a string, and without it the array infers from its first
  // element — the same trap servicesMedia's parameter list hit.
  /** @type {Array<string|number>} */
  const params = [limit];
  let filter = "";
  if (status) {
    params.push(status);
    filter = `WHERE d.status = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT d.id, d.amount_cents, d.currency, d.type, d.status, d.created_at,
            d.stripe_payment_intent,
            u.id AS donor_id, u.display_name AS donor_name, u.email AS donor_email
     FROM donations d
     LEFT JOIN users u ON u.id = d.donor_id
     ${filter}
     ORDER BY d.created_at DESC
     LIMIT $1`,
    params
  );
  return result.rows;
};

// The totals an admin actually reconciles against: money in, and what is stuck.
// Grouped in SQL rather than counted in JavaScript over the bounded list above,
// which would be wrong the moment there are more donations than the limit.
export const getDonationTotals = async () => {
  const result = await pool.query(
    `SELECT status,
            COUNT(*)::int AS count,
            COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
     FROM donations
     GROUP BY status`
  );
  return result.rows.map((row) => ({ ...row, total_cents: Number(row.total_cents) }));
};

export const getDonationsByUser = async (userId) => {
  const result = await pool.query(
    "SELECT * FROM donations WHERE donor_id=$1 ORDER BY created_at DESC",
    [userId]
  );
  return result.rows;
};
