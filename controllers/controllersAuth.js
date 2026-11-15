// @ts-check
import * as servicesAuth from "../services/servicesAuth.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../lib/mailer.js";
import { notifyAdmins, NOTIFICATION_TYPES } from "../services/servicesNotifications.js";
import { AppError, badRequest } from "../lib/AppError.js";
import { normalizeEmail } from "../lib/validate.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { captureError } from "../lib/monitoring.js";
import { OAUTH_PROVIDERS, newOAuthChallenge } from "../lib/oauthProviders.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax",
  secure: env.isProduction,
  maxAge: SEVEN_DAYS_MS,
  path: "/",
});

const setAuthCookie = (res, token) => res.cookie("token", token, cookieOptions());
const clearAuthCookie = (res) => res.clearCookie("token", { ...cookieOptions(), maxAge: undefined });

// REG-11. An admin used to learn of a role request only by happening to open the
// users page. Both doors to a request — signing up with one, and asking later
// from the profile — come through here.
//
// Not awaited, like the verification mail: the request is already saved, and
// mailing every admin must neither delay the answer nor fail it (notifyAdmins
// never throws). Only for a request actually left waiting — a student signing
// up asks for nothing.
const tellAdminsIfPending = (user) => {
  if (user?.approval_status !== "pending" || !user.requested_role) return;
  void notifyAdmins(NOTIFICATION_TYPES.ROLE_REQUEST, {
    userId: user.id,
    displayName: user.display_name,
    email: user.email,
    requestedRole: user.requested_role,
  });
};

export const register = async (req, res) => {
  const { email, password, displayName, requestedRole } = req.body;
  if (!email || !password) throw badRequest("Email and password are required");
  // Named `requestedRole` in the body, not `role`, and that is not cosmetic: a
  // field called `role` on a public endpoint invites the next reader to wire it
  // to users.role. The name says what it is — an application, not a grant.
  const { user, token, verification } = await servicesAuth.register(
    email,
    password,
    displayName,
    requestedRole ?? "student"
  );
  setAuthCookie(res, token);
  // Sent after the account exists and the session is open, and never awaited for
  // its outcome: a mail server being down must not turn a successful
  // registration into an error that invites the user to register again, which
  // would then fail on the email being taken.
  sendVerificationEmail(user.email, verification).catch(() => {});
  tellAdminsIfPending(user);
  res.status(201).json({ user });
};

export const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw badRequest("Email and password are required");
  const { user, token } = await servicesAuth.login(email, password);
  setAuthCookie(res, token);
  res.status(200).json({ user });
};

export const googleCallback = (req, res) => {
  setAuthCookie(res, servicesAuth.issueSessionToken(req.user));
  res.redirect(`${env.clientUrl}/auth/google/callback`);
};

// ── Apple and LinkedIn ──────────────────────────────────────────────────────
//
// The browser goes out to the provider from `oauthStart` and comes back to
// `oauthCallback` — GET for LinkedIn, a form POST for Apple. What ties the two
// ends together is a short-lived cookie holding the state and nonce: the
// callback refuses any state that is not the one THIS browser was sent with,
// which is what stops somebody planting their own authorization code on a
// victim and signing them into the attacker's account.

const OAUTH_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const challengeCookieName = (provider) => `oauth_${provider}`;

// Path-scoped to the one callback that reads it. Apple's callback arrives as a
// cross-site POST, which a SameSite=Lax cookie is not sent with — so for Apple
// it is None, which browsers accept only together with Secure (localhost counts
// as secure, so development still works). LinkedIn returns with a top-level GET,
// which Lax allows.
const challengeCookieOptions = (provider, { callbackMethod }) => ({
  httpOnly: true,
  sameSite: callbackMethod === "post" ? "none" : "lax",
  secure: callbackMethod === "post" ? true : env.isProduction,
  maxAge: OAUTH_CHALLENGE_TTL_MS,
  path: `/api/auth/${provider}/callback`,
});

// The address the provider returns the browser to. Built from the request,
// exactly as passport builds Google's from its relative callbackURL — so behind
// a proxy TRUST_PROXY must be set for the scheme to come out as https, the same
// requirement Google already has. It must also match, character for character,
// a redirect URL registered with the provider.
const callbackUrlFor = (req, provider) => `${req.protocol}://${req.get("host")}/api/auth/${provider}/callback`;

const backToSignIn = (res, reason) => res.redirect(`${env.clientUrl}/sign-in?error=${reason}`);

/** @param {"apple"|"linkedin"} provider */
export const oauthStart = (provider) => (req, res) => {
  const definition = OAUTH_PROVIDERS[provider];
  if (!definition.configured()) return backToSignIn(res, `${provider}_unavailable`);
  const { state, nonce } = newOAuthChallenge();
  res.cookie(challengeCookieName(provider), `${state}.${nonce}`, challengeCookieOptions(provider, definition));
  res.redirect(definition.authorizationUrl({ redirectUri: callbackUrlFor(req, provider), state, nonce }));
};

/** @param {"apple"|"linkedin"} provider */
export const oauthCallback = (provider) => async (req, res) => {
  const definition = OAUTH_PROVIDERS[provider];
  // Apple posts a form; LinkedIn appends a query string.
  const params = (definition.callbackMethod === "post" ? req.body : req.query) ?? {};
  const [expectedState, nonce] = String(req.cookies?.[challengeCookieName(provider)] ?? "").split(".");
  // Spent either way: a challenge is good for exactly one return.
  res.clearCookie(challengeCookieName(provider), { ...challengeCookieOptions(provider, definition), maxAge: undefined });

  // The provider's own refusal ("access_denied" when the user pressed cancel)
  // and a state that is missing or not ours both end at the sign-in page, before
  // any call to the provider is made.
  if (params.error || !params.code || !expectedState || params.state !== expectedState) {
    return backToSignIn(res, `${provider}_failed`);
  }

  // The one handler with its own try/catch, for the reason config/passport.js
  // gives for Google: the user is mid-redirect in a browser, and errorHandler's
  // JSON body is a dead end there. Every failure goes back to the sign-in page;
  // only the ones that are not a refusal are reported as ours.
  try {
    const identity = await definition.identify({
      code: String(params.code),
      redirectUri: callbackUrlFor(req, provider),
      nonce,
      params,
    });
    const user = await servicesAuth.oauthLogin(provider, identity);
    setAuthCookie(res, servicesAuth.issueSessionToken(user));
    res.redirect(`${env.clientUrl}/auth/callback`);
  } catch (err) {
    if (err instanceof AppError) {
      logger.info(`[auth] ${definition.label} sign-in refused: ${err.message}`);
    } else {
      logger.error(`[auth] ${definition.label} sign-in failed: ${err.message}`);
      captureError(err, { tags: { provider } });
    }
    backToSignIn(res, `${provider}_failed`);
  }
};

export const logout = (req, res) => {
  clearAuthCookie(res);
  res.status(200).json({ message: "Logged out" });
};

export const getMe = async (req, res) => {
  const user = await servicesAuth.getMe(req.user.id);
  res.status(200).json(user);
};

// ── Account recovery ────────────────────────────────────────────────────────

// Always 200, and always the same body.
//
// The response cannot depend on whether the address has an account, or this
// endpoint becomes a way to test a list of addresses against the membership —
// submit, keep the ones that answer differently. The sentence sent back is
// deliberately conditional ("if there is an account") so it is also TRUE in both
// cases rather than a comfortable lie in one of them.
export const forgotPassword = async (req, res) => {
  const { email } = req.body ?? {};
  if (!email || typeof email !== "string") throw badRequest("Email is required");

  const token = await servicesAuth.requestPasswordReset(email);
  if (token) sendPasswordResetEmail(normalizeEmail(email), token).catch(() => {});

  res.status(200).json({
    message: "If that address has an account, a reset link is on its way",
  });
};

// A successful reset signs the user in, rather than returning them to the login
// form to type the password they just chose. The cookie is minted AFTER the
// change, so it survives the password_changed_at check that has just invalidated
// every older session.
export const resetPassword = async (req, res) => {
  const { token, password } = req.body ?? {};
  if (!token || typeof token !== "string") throw badRequest("Reset token is required");

  const { user } = await servicesAuth.resetPassword(token, password);
  setAuthCookie(res, servicesAuth.issueSessionToken(user));
  res.status(200).json({ user });
};

export const verifyEmail = async (req, res) => {
  const { token } = req.body ?? {};
  if (!token || typeof token !== "string") throw badRequest("Verification token is required");
  const user = await servicesAuth.verifyEmail(token);
  res.status(200).json(user);
};

// ── The signed-in user's own account ────────────────────────────────────────

export const updateProfile = async (req, res) => {
  const { displayName, avatarUrl } = req.body ?? {};
  const user = await servicesAuth.updateProfile(req.user.id, { displayName, avatarUrl });
  res.status(200).json(user);
};

// Changing the password ends every other session, including any the person doing
// it has open elsewhere — so this one is re-issued, or they would be signed out
// of the tab they just used.
export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  await servicesAuth.changePassword(req.user.id, currentPassword, newPassword);
  setAuthCookie(res, servicesAuth.issueSessionToken(req.user));
  res.status(200).json({ message: "Password changed" });
};

// Asking for a role from inside the app, after registration.
//
// Authenticated, and it acts on req.user.id — never on an id from the body.
// That is what makes it safe to expose to every signed-in user: there is no
// parameter to point at somebody else's account, so the worst a caller can do is
// apply on their own behalf, which is the feature.
export const requestRole = async (req, res) => {
  const { requestedRole } = req.body ?? {};
  if (!requestedRole) throw badRequest("requestedRole is required");
  const user = await servicesAuth.requestRole(req.user.id, requestedRole);
  tellAdminsIfPending(user);
  res.status(200).json(user);
};

