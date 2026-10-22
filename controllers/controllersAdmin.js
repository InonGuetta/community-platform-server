// @ts-check
import * as servicesAdmin from "../services/servicesAdmin.js";
import * as servicesDonations from "../services/servicesDonations.js";
import { reconcileMissingTranscripts } from "../services/servicesTranscripts.js";
import * as servicesTags from "../services/servicesTags.js";
import { logger } from "../lib/logger.js";
import { badRequest } from "../lib/AppError.js";

export const getStats = async (req, res) => {
  const stats = await servicesAdmin.getStats();
  res.status(200).json(stats);
};

export const getQueueStatus = async (req, res) => {
  const status = await servicesAdmin.getQueueStatus();
  res.status(200).json(status);
};

export const getSystemHealth = async (req, res) => {
  const health = await servicesAdmin.getSystemHealth();
  res.status(200).json(health);
};

// What failed, and what never got queued at all — one call, because they are two
// halves of the same question and an admin looking at either alone draws the
// wrong conclusion.
export const getPipelineTrouble = async (req, res) => {
  const [failed, stranded] = await Promise.all([
    servicesAdmin.getFailedJobs(),
    servicesAdmin.getStrandedMedia(),
  ]);
  res.status(200).json({ failed, stranded });
};

// The reconcile sweep, on demand.
//
// It has existed since the pipeline was written — bounded per run, timeout-
// guarded, and refusing anything already live — and could only ever be triggered
// by the transcription worker's Redis reconnecting. An admin who could SEE that
// something was stranded had no way to act on it; the only route back was finding
// the lecturer and asking them to press the button again.
//
// Running it from the API process rather than the worker is safe for a reason
// worth stating: the per-process lock in lib/inFlight.js does NOT span processes,
// so this can overlap with the worker's own sweep. What actually prevents double
// work is Bull's fixed job id — `media:<id>` — which triggerPipeline refuses
// while a job is live. The overlap costs a conflict, not a second Whisper bill.
export const runReconcile = async (req, res) => {
  logger.info(`[admin] reconcile requested by user ${req.user.id}`);
  const result = await reconcileMissingTranscripts();
  res.status(200).json(result);
};

// ── Donations ───────────────────────────────────────────────────────────────

// The ledger and its totals together: a list an admin can read against Stripe,
// and the sums to check it adds up to. getStats reports only the completed
// total, which is a number with nothing behind it.
//
// The filter is checked against the donation_status enum (migration 006): any
// other value used to reach Postgres as "invalid input value for enum" — a 500
// for what is a plain bad request.
const DONATION_STATUSES = new Set(["pending", "completed", "failed"]);

export const getDonations = async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && (typeof status !== "string" || !DONATION_STATUSES.has(status))) {
    throw badRequest(`status must be one of: ${[...DONATION_STATUSES].join(", ")}`);
  }
  const [donations, totals] = await Promise.all([
    servicesDonations.getAllDonations({ status }),
    servicesDonations.getDonationTotals(),
  ]);
  res.status(200).json({ donations, totals });
};

// ── New tags waiting for approval ───────────────────────────────────────────
//
// requireRole("admin") on the whole router is the only question here: the
// admin may decide on any proposal, so there is no per-row ownership check.

export const getTagProposals = async (req, res) => {
  res.status(200).json(await servicesTags.getPendingProposals());
};

// The body may correct the name and the place before approving. `parentId`
// present (even as null) means "put it here"; absent means "where it was asked".
export const approveTagProposal = async (req, res) => {
  const body = req.body ?? {};
  const changes = {};
  if (body.name !== undefined) changes.name = body.name;
  if ("parentId" in body) changes.parentId = body.parentId;
  const result = await servicesTags.approveTagProposal(req.params.id, req.user.id, changes);
  logger.info(`[BE:ctl] tag proposal ${req.params.id} approved by ${req.user.id} → tag ${result.tag_id}, ${result.tagged_count} item(s)`);
  res.status(200).json(result);
};

export const rejectTagProposal = async (req, res) => {
  const result = await servicesTags.rejectTagProposal(req.params.id, req.user.id, req.body?.reason);
  logger.info(`[BE:ctl] tag proposal ${req.params.id} rejected by ${req.user.id}`);
  res.status(200).json(result);
};
