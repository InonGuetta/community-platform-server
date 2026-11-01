// @ts-check
import * as servicesNotifications from "../services/servicesNotifications.js";
import { notFound } from "../lib/AppError.js";

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
  if (req.user.role === "admin") {
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
