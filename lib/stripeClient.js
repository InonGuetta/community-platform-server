// @ts-check
// The one Stripe client.
//
// There were two: servicesDonations built one to create charges and
// controllersDonations built another to verify webhook signatures. Two clients
// is two connection pools, two places to configure an API version, and two
// chances for one of them to be constructed with a key the other does not have —
// which is exactly the shape of failure that is invisible until a payment.
//
// Same reasoning as lib/storage.js's shared S3 client, and the same placement:
// a lib module that owns one external dependency, so nothing above it has to
// know how it is built.
import Stripe from "stripe";
import { env } from "./env.js";

export const stripe = new Stripe(env.stripeSecretKey);

// Whether webhook verification can actually happen. Asks whether a value was
// SUPPLIED — like s3Configured — because env carries no default here and a
// missing secret must be a refusal rather than a signature check against
// undefined, which the SDK would fail in a less obvious way.
export const webhookVerifiable = () => Boolean(env.stripeWebhookSecret);

// Whether a card can actually be taken (PRD PAY-1): a real-looking secret key
// and its publishable twin from the same mode. The keys in .env.example are
// placeholders ("sk_test_..."), and with those every intent would fail at
// Stripe with an authentication error the donor could make nothing of — so the
// page is told plainly instead, before a donation row is even written.
const looksReal = (key, prefix) =>
  typeof key === "string" && key.startsWith(prefix) && key.length > 20 && !key.includes("...");

export const paymentsConfigured = () => {
  const secret = env.stripeSecretKey;
  const publishable = env.stripePublishableKey;
  if (!looksReal(secret, "sk_") || !looksReal(publishable, "pk_")) return false;
  // A test secret with a live publishable key (or the reverse) fails at
  // confirmation, after the donor has typed their card.
  return secret.startsWith("sk_test_") === publishable.startsWith("pk_test_");
};
