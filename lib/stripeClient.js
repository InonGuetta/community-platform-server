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
