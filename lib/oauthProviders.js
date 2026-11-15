// @ts-check
// Signing in with Apple and with LinkedIn — the two providers beside Google.
//
// Google goes through passport (config/passport.js) because it was there first.
// These two are plain OAuth 2.0 / OpenID Connect authorization-code flows written
// out here instead, with no new dependency: Node's own fetch for the two calls to
// each provider, and the jsonwebtoken already used for sessions to sign Apple's
// client secret. Neither has a passport strategy that is both maintained and
// current — LinkedIn retired the API the old strategies call.
//
// What this module does NOT do is decide who the user is in OUR database. It
// turns a provider's answer into one neutral shape —
//   { id, email, emailVerified, displayName, avatarUrl }
// — and servicesAuth.oauthLogin decides what that identity is allowed to claim,
// with the same rules Google's has always had.
//
// The id_token is checked for issuer, audience, expiry and nonce, but its
// signature is not fetched and verified against the provider's keys. That is
// deliberate and permitted (OpenID Connect Core §3.1.3.7, item 6): the token
// is never handed to us by the browser — it arrives in the body of OUR request
// to the provider's token endpoint, over TLS, authenticated with our client
// secret. Nobody in between can substitute it, and verifying a signature on it
// would add a key fetch, a cache and a rotation path that protect nothing.
import { randomBytes } from "crypto";
import jwt from "jsonwebtoken";
import { env } from "./env.js";

/** @typedef {{ id: string, email: string|null, emailVerified: boolean, displayName: string|null, avatarUrl: string|null }} OAuthIdentity */

// Apple and LinkedIn both send "true" as a string in some places and a boolean
// in others. Anything else — missing, "false", a shape we have not seen — is
// UNVERIFIED, for the same reason Google's check defaults that way: a provider
// changing a field must not silently start linking accounts on an unproven
// address.
const isTrue = (value) => value === true || value === "true";

// The provider answered something other than success. A plain Error, not an
// AppError: the controller turns every failure here into a redirect back to the
// sign-in page, and the message is for the log.
const providerError = (provider, what, status) =>
  new Error(`${provider} ${what} failed${status ? ` (HTTP ${status})` : ""}`);

// What a provider answers is JSON we did not write; every field is checked
// where it is read, so it is typed as a bag of unknowns rather than trusted.
/** @returns {Promise<Record<string, any>>} */
const readJson = async (res) => {
  const body = await res.json();
  return body && typeof body === "object" ? body : {};
};

/** @returns {Promise<Record<string, any>>} */
const postForm = async (provider, url, fields) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
  if (!res.ok) throw providerError(provider, "token exchange", res.status);
  return readJson(res);
};

// The claims of an id_token received from the token endpoint (see the header
// for why the signature is not re-checked). Everything that IS checked is what
// would let a token minted for somebody else's app, or an old one, through.
const checkedIdTokenClaims = (provider, idToken, { issuer, audience, nonce }) => {
  const claims = typeof idToken === "string" ? jwt.decode(idToken) : null;
  if (!claims || typeof claims !== "object") throw providerError(provider, "id_token decode");
  if (claims.iss !== issuer) throw providerError(provider, "id_token issuer check");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) throw providerError(provider, "id_token audience check");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
    throw providerError(provider, "id_token expiry check");
  }
  if (claims.nonce !== nonce) throw providerError(provider, "id_token nonce check");
  if (typeof claims.sub !== "string" || !claims.sub) throw providerError(provider, "id_token subject");
  return claims;
};

// ── Apple ───────────────────────────────────────────────────────────────────

const APPLE_ISSUER = "https://appleid.apple.com";

// Apple has no static client secret: it is a short-lived JWT, signed ES256 with
// the .p8 key downloaded from the developer account. Five minutes is plenty —
// it is minted for one token request and thrown away.
//
// A .p8 pasted into a single-line .env value usually arrives with its newlines
// written as "\n"; they are put back, or the PEM does not parse.
const appleClientSecret = () =>
  jwt.sign({}, String(env.applePrivateKey).replace(/\\n/g, "\n"), {
    algorithm: "ES256",
    keyid: env.appleKeyId,
    issuer: env.appleTeamId,
    subject: env.appleClientId,
    audience: APPLE_ISSUER,
    expiresIn: "5m",
  });

// Apple sends the user's name exactly once — on the very first authorization,
// as a JSON form field beside the code — and never again, not even in the
// id_token. Read defensively: it is browser-supplied, and a malformed one must
// cost us the name, not the sign-in.
const appleNameFrom = (userField) => {
  if (typeof userField !== "string" || !userField) return null;
  try {
    const name = JSON.parse(userField)?.name;
    const full = [name?.firstName, name?.lastName].filter((p) => typeof p === "string" && p.trim()).join(" ");
    return full.trim() || null;
  } catch {
    return null;
  }
};

const apple = {
  label: "Apple",
  configured: () => env.appleConfigured,
  // form_post is not a preference: Apple refuses to return the `name` and
  // `email` scopes any other way. It also means the callback is a cross-site
  // POST, which is why the state cookie for this provider is SameSite=None.
  callbackMethod: "post",
  authorizationUrl: ({ redirectUri, state, nonce }) =>
    `${APPLE_ISSUER}/auth/authorize?${new URLSearchParams({
      response_type: "code",
      response_mode: "form_post",
      client_id: String(env.appleClientId),
      redirect_uri: redirectUri,
      scope: "name email",
      state,
      nonce,
    })}`,
  /** @returns {Promise<OAuthIdentity>} */
  identify: async ({ code, redirectUri, nonce, params }) => {
    const tokens = await postForm("Apple", `${APPLE_ISSUER}/auth/token`, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: String(env.appleClientId),
      client_secret: appleClientSecret(),
    });
    const claims = checkedIdTokenClaims("Apple", tokens.id_token, {
      issuer: APPLE_ISSUER,
      audience: String(env.appleClientId),
      nonce,
    });
    return {
      id: claims.sub,
      email: typeof claims.email === "string" ? claims.email : null,
      emailVerified: isTrue(claims.email_verified),
      displayName: appleNameFrom(params.user),
      // Apple has no profile picture to give.
      avatarUrl: null,
    };
  },
};

// ── LinkedIn ────────────────────────────────────────────────────────────────

// "Sign In with LinkedIn using OpenID Connect" — the product LinkedIn offers
// since retiring the r_liteprofile API in 2023. The identity is read from the
// userinfo endpoint with the access token rather than from the id_token: same
// claims, and no dependence on the exact issuer string LinkedIn puts in it.
const linkedin = {
  label: "LinkedIn",
  configured: () => env.linkedinConfigured,
  callbackMethod: "get",
  authorizationUrl: ({ redirectUri, state }) =>
    `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({
      response_type: "code",
      client_id: String(env.linkedinClientId),
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state,
    })}`,
  /** @returns {Promise<OAuthIdentity>} */
  identify: async ({ code, redirectUri }) => {
    const tokens = await postForm("LinkedIn", "https://www.linkedin.com/oauth/v2/accessToken", {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: String(env.linkedinClientId),
      client_secret: String(env.linkedinClientSecret),
    });
    if (typeof tokens.access_token !== "string") throw providerError("LinkedIn", "token exchange");
    const res = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!res.ok) throw providerError("LinkedIn", "userinfo", res.status);
    const info = await readJson(res);
    if (typeof info.sub !== "string" || !info.sub) throw providerError("LinkedIn", "userinfo subject");
    return {
      id: info.sub,
      email: typeof info.email === "string" ? info.email : null,
      emailVerified: isTrue(info.email_verified),
      displayName: typeof info.name === "string" ? info.name : null,
      avatarUrl: typeof info.picture === "string" ? info.picture : null,
    };
  },
};

export const OAUTH_PROVIDERS = { apple, linkedin };

// The values that tie a callback to the browser that started it. `state` is
// compared against the cookie set at the start (it is what stops somebody
// sending a victim to our callback with the attacker's own code); `nonce` is
// carried inside Apple's id_token and compared too.
export const newOAuthChallenge = () => ({
  state: randomBytes(24).toString("hex"),
  nonce: randomBytes(24).toString("hex"),
});
