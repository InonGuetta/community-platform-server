// @ts-check
import * as servicesTranscripts from "../services/servicesTranscripts.js";
import * as servicesMedia from "../services/servicesMedia.js";
import { logger } from "../lib/logger.js";
import { isPrivileged, assertCanManageMedia } from "../lib/permissions.js";
import { badRequest } from "../lib/AppError.js";

// A transcript has no owner of its own — it belongs to whoever uploaded the media
// item, so the check has to go through that item. servicesTranscripts is left
// alone deliberately: its queries never needed uploader_id, and getMediaById
// already returns it, so this costs one lookup and no change to the service.
//
// Every caller below runs this FIRST, before any queue or OpenAI work. A refused
// request therefore costs one query rather than a GPT-4o bill.
const assertMayEditTranscript = async (req) => {
  assertCanManageMedia(req.user, await servicesMedia.getMediaById(req.params.mediaId));
};

export const getTranscript = async (req, res) => {
  const { mediaId } = req.params;
  const transcript = await servicesTranscripts.getTranscriptByMediaId(mediaId, isPrivileged(req.user));
  logger.debug(`[BE:ctrl] GET /transcripts/${mediaId} ✓ status=${transcript.status} chunks=${transcript.chunks?.length ?? 0}`);
  res.status(200).json(transcript);
};

export const updateTranscript = async (req, res) => {
  await assertMayEditTranscript(req);
  const transcript = await servicesTranscripts.updateTranscript(req.params.mediaId, req.body);
  res.status(200).json(transcript);
};

export const triggerPipeline = async (req, res) => {
  await assertMayEditTranscript(req);
  const result = await servicesTranscripts.triggerPipeline(req.params.mediaId);
  logger.debug(`[BE:ctrl] POST /transcripts/${req.params.mediaId}/trigger ✓ jobId=${result.jobId}`);
  res.status(200).json(result);
};

export const fixHebrew = async (req, res) => {
  await assertMayEditTranscript(req);
  const transcript = await servicesTranscripts.fixHebrewTranscript(req.params.mediaId);
  res.status(200).json(transcript);
};

export const generateKeyPointHeadings = async (req, res) => {
  await assertMayEditTranscript(req);
  const transcript = await servicesTranscripts.generateKeyPointHeadings(req.params.mediaId);
  res.status(200).json(transcript);
};

const SEARCH_MODES = new Set(["keyword", "semantic", "hybrid"]);

export const searchTranscripts = async (req, res) => {
  const { q } = req.query;
  if (!q) throw badRequest("Query parameter 'q' is required");
  // Default to hybrid; ignore anything unrecognised rather than 400 so a stray
  // mode value can't break search.
  const mode = SEARCH_MODES.has(req.query.mode) ? req.query.mode : "hybrid";
  const results = await servicesTranscripts.searchTranscripts(q, mode, isPrivileged(req.user));
  res.status(200).json(results);
};
