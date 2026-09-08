// @ts-check
import * as servicesUsers from "../services/servicesUsers.js";
import { sendRoleDecisionEmail } from "../lib/mailer.js";

export const getAllUsers = async (req, res) => {
  const users = await servicesUsers.getAllUsers();
  res.status(200).json(users);
};

export const getUserById = async (req, res) => {
  const user = await servicesUsers.getUserById(req.params.id);
  res.status(200).json(user);
};

export const createUser = async (req, res) => {
  const user = await servicesUsers.createUser(req.body);
  res.status(201).json(user);
};

export const updateUser = async (req, res) => {
  const user = await servicesUsers.updateUser(req.params.id, req.body);
  res.status(200).json(user);
};

export const deleteUser = async (req, res) => {
  const result = await servicesUsers.deleteUser(req.params.id);
  res.status(200).json(result);
};

// ── Role approval ───────────────────────────────────────────────────────────
//
// Mounted under /api/users, which routersUsers guards with
// requireRole("admin") for the whole router — so these three inherit that and
// do not repeat it. The self-approval check is NOT inherited and lives in the
// service, because it depends on who is calling, not on their role.

export const getPendingApprovals = async (req, res) => {
  const pending = await servicesUsers.getPendingApprovals();
  res.status(200).json(pending);
};

export const approveUser = async (req, res) => {
  const user = await servicesUsers.approveUser(req.params.id, req.user.id);
  // Not awaited, and the pattern is register's: a mail server being down must
  // not turn a decision that has already been committed into an error the admin
  // would reasonably retry — and retrying would then fail on "already decided".
  sendRoleDecisionEmail(user.email, { approved: true, role: user.role }).catch(() => {});
  res.status(200).json(user);
};

export const rejectUser = async (req, res) => {
  const { reason } = req.body ?? {};
  const user = await servicesUsers.rejectUser(req.params.id, req.user.id, reason);
  sendRoleDecisionEmail(user.email, {
    approved: false,
    role: user.requested_role,
    reason: user.rejection_reason,
  }).catch(() => {});
  res.status(200).json(user);
};
