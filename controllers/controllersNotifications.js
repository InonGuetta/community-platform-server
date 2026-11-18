// @ts-check
import * as servicesNotifications from "../services/servicesNotifications.js";
import { notFound, badRequest, ERROR_CODES } from "../lib/AppError.js";
import { requireOneChannel, requireCategory } from "../lib/validate.js";
import { getPhoneState } from "../services/servicesPhone.js";
import { readUnsubscribeToken } from "../lib/unsubscribe.js";
import { isAdmin } from "../lib/permissions.js";

// The bell. Every handler acts on req.user.id; the only id from the request is a
// notification's, and the service only ever looks it up together with the
// caller — another user's id is a 404, like one that does not exist.

// One request answers the whole navbar: the latest notifications, the unread
// count, and — for an admin — how many role requests are waiting, which is the
// counter on the "משתמשים" tab (REG-11). One poll rather than two, because the
// navbar asks every minute on every open tab of every signed-in user.
export const getNotifications = async (req, res) => {
  const { items, unread } = await servicesNotifications.listForUser(req.user.id);
  const body = { items, unread };
  if (isAdmin(req.user)) {
    body.pendingRoleRequests = await servicesNotifications.countPendingRoleRequests();
  }
  res.status(200).json(body);
};

export const markRead = async (req, res) => {
  const found = await servicesNotifications.markRead(req.user.id, req.params.id);
  if (!found) throw notFound("Notification not found");
  res.status(204).end();
};

export const markAllRead = async (req, res) => {
  await servicesNotifications.markAllRead(req.user.id);
  res.status(204).end();
};

// ── Preferences (NOTIF-6) ───────────────────────────────────────────────────
//
// Which mail this user can receive at all (by role) and which of it they have
// turned off. The bell is not switchable — see EMAIL_CATEGORIES.
//
// And, per category, whether it goes by SMS (migration 054): `sms` is a boolean
// for a category an SMS can carry, null for one it cannot. `phoneVerified`
// says whether turning SMS on can work yet.
export const getPreferences = async (req, res) => {
  const [optOuts, optIns, phone] = await Promise.all([
    servicesNotifications.getEmailOptOuts(req.user.id),
    servicesNotifications.getSmsOptIns(req.user.id),
    getPhoneState(req.user.id),
  ]);
  const optedOut = new Set(optOuts);
  const smsOn = new Set(optIns);
  const categories = Object.entries(servicesNotifications.EMAIL_CATEGORIES)
    .filter(([, c]) => c.roles.includes(req.user.role))
    .map(([key]) => ({
      key,
      email: !optedOut.has(key),
      sms: servicesNotifications.SMS_CATEGORIES.includes(key) ? smsOn.has(key) : null,
    }));
  res.status(200).json({
    categories,
    allOff: optedOut.has(servicesNotifications.ALL_CATEGORIES),
    phoneVerified: Boolean(phone.phone),
  });
};

export const setPreference = async (req, res) => {
  const { channel, on } = requireOneChannel(req.body);
  if (channel === "email") {
    const category = requireCategory(req.body.category, servicesNotifications.isEmailCategory, "Unknown notification category");
    await servicesNotifications.setEmailPreference(req.user.id, category, on);
    return res.status(204).end();
  }
  const category = requireCategory(req.body.category, servicesNotifications.isSmsCategory, "This category is not sent by SMS");
  const done = await servicesNotifications.setSmsPreference(req.user, category, on);
  if (!done) throw badRequest("No verified phone number", ERROR_CODES.PHONE_NOT_VERIFIED);
  res.status(204).end();
};

// The "הפסקת מיילים מסוג זה" link. No session: it is followed from an inbox,
// and the signed token is the credential (lib/unsubscribe.js). It can turn the
// named category off — or, with `all`, every category — and nothing else.
//
// A POST, from the client's confirmation page. The mail links to that page
// rather than here, because a GET that acted would be triggered by every link
// scanner that previews the message.
export const unsubscribe = async (req, res) => {
  const { token, all } = req.body ?? {};
  const claim = readUnsubscribeToken(token);
  if (!claim || !servicesNotifications.isEmailCategory(claim.category)) {
    throw badRequest("This unsubscribe link is not valid");
  }
  const category = all === true ? servicesNotifications.ALL_CATEGORIES : claim.category;
  await servicesNotifications.setEmailPreference(claim.userId, category, false);
  res.status(200).json({ category });
};
