import * as servicesTranscripts from "../services/servicesTranscripts.js";
import { logger } from "../lib/logger.js";
import { badRequest } from "../lib/AppError.js";

export const getTranscript = async (req, res) => {
  const { mediaId } = req.params;
  const transcript = await servicesTranscripts.getTranscriptByMediaId(mediaId);
  logger.debug(`[BE:ctrl] GET /transcripts/${mediaId} ✓ status=${transcript.status} chunks=${transcript.chunks?.length ?? 0}`);
  res.status(200).json(transcript);
};

export const updateTranscript = async (req, res) => {
  const transcript = await servicesTranscripts.updateTranscript(req.params.mediaId, req.body);
  res.status(200).json(transcript);
};

export const triggerPipeline = async (req, res) => {
  const result = await servicesTranscripts.triggerPipeline(req.params.mediaId);
  logger.debug(`[BE:ctrl] POST /transcripts/${req.params.mediaId}/trigger ✓ jobId=${result.jobId}`);
  res.status(200).json(result);
};

export const fixHebrew = async (req, res) => {
  const transcript = await servicesTranscripts.fixHebrewTranscript(req.params.mediaId);
  res.status(200).json(transcript);
};

export const generateKeyPointHeadings = async (req, res) => {
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
  const results = await servicesTranscripts.searchTranscripts(q, mode);
  res.status(200).json(results);
};
