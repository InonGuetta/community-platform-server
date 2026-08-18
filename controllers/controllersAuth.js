// @ts-check
import * as servicesAuth from "../services/servicesAuth.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../lib/mailer.js";
import { badRequest } from "../lib/AppError.js";
import { env } from "../lib/env.js";

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

export const register = async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) throw badRequest("Email and password are required");
  const { user, token, verification } = await servicesAuth.register(email, password, displayName);
  setAuthCookie(res, token);
  // Sent after the account exists and the session is open, and never awaited for
  // its outcome: a mail server being down must not turn a successful
  // registration into an error that invites the user to register again, which
  // would then fail on the email being taken.
  sendVerificationEmail(user.email, verification).catch(() => {});
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
  if (token) sendPasswordResetEmail(email.trim().toLowerCase(), token).catch(() => {});

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
