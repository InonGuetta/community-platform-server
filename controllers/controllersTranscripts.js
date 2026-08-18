// @ts-check
import * as servicesTranscripts from "../services/servicesTranscripts.js";
import * as servicesMedia from "../services/servicesMedia.js";
import { logger } from "../lib/logger.js";
import { assertCanManageMedia } from "../lib/permissions.js";
import { visibleCoursesFor } from "../services/servicesVisibility.js";
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
  const transcript = await servicesTranscripts.getTranscriptByMediaId(
    mediaId,
    await visibleCoursesFor(req.user)
  );
  logger.debug(`[BE:ctrl] GET /transcripts/${mediaId} ✓ status=${transcript.status} chunks=${transcript.chunks?.length ?? 0}`);
  res.status(200).json(transcript);
};

// `status` is deliberately NOT among the fields taken from the body, and this is
// the point of the allowlist rather than an oversight.
//
// transcript_status is the contract the whole pipeline and the polling UI run on
// — pending → processing → analyzing → done, or error. Every legitimate
// transition is written by the code that earned it: the workers move the row with
// their own UPDATEs, and 'done' is written in the same statement as the summary
// precisely so the row is never advertised as finished before the content it
// promises exists. Nothing in that sequence goes through here.
//
// Passing req.body straight through handed a lecturer the ability to write any
// of it. Sending {"status":"done"} on a row still at 'pending' stopped the
// client's polling before the summary existed — reintroducing, by hand, the exact
// bug the 'analyzing' state was added to fix — and a value outside the enum
// reached Postgres as "invalid input value for enum" and surfaced as a 500.
//
// An allowlist rather than a `delete body.status`: it also covers whatever column
// this service learns to write next, which a denylist would silently expose on
// the day it was added.
const EDITABLE_FIELDS = ["editedText", "aiSummary", "aiChapters", "aiKeyPoints"];

export const updateTranscript = async (req, res) => {
  await assertMayEditTranscript(req);
  const body = req.body ?? {};
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in body) patch[field] = body[field];
  }
  const transcript = await servicesTranscripts.updateTranscript(req.params.mediaId, patch);
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

// Every search is an OpenAI embedding plus, in hybrid mode, a GPT-4o rerank —
// both billed by input size. The route's rate limiter caps how OFTEN a client may
// search; nothing capped how LARGE a single search could be, so one request could
// carry a payload far past anything a person would type. Long past the point of
// being a useful query it is only a bill.
//
// 300 characters is well beyond a real Hebrew search phrase and nowhere near the
// embedding model's own limit, so this rejects abuse without ever refusing a
// question somebody meant to ask.
const MAX_QUERY_CHARS = 300;

export const searchTranscripts = async (req, res) => {
  const { q } = req.query;
  if (!q) throw badRequest("Query parameter 'q' is required");
  if (typeof q !== "string") throw badRequest("Query parameter 'q' must be a single value");
  if (q.length > MAX_QUERY_CHARS) {
    throw badRequest(`Search query must be at most ${MAX_QUERY_CHARS} characters`);
  }
  // Default to hybrid; ignore anything unrecognised rather than 400 so a stray
  // mode value can't break search.
  const mode = SEARCH_MODES.has(req.query.mode) ? req.query.mode : "hybrid";
  const results = await servicesTranscripts.searchTranscripts(
    q,
    mode,
    await visibleCoursesFor(req.user)
  );
  res.status(200).json(results);
};
