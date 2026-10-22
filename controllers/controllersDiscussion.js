// @ts-check
import * as servicesDiscussion from "../services/servicesDiscussion.js";
import { viewerScopeFor } from "../services/servicesVisibility.js";
import { badRequest, ERROR_CODES } from "../lib/AppError.js";

// Same ceiling as the library-wide search, for the same reason: every search is
// an embedding plus a GPT-4o rerank, billed by input size, and nothing a person
// types into a search box comes near 300 characters.
export const MAX_QUERY_CHARS = 300;

// Visibility is decided in the service, before any chunk is read — the same
// arrangement as GET /api/transcripts/:mediaId. Anyone who may see the lesson
// may search it; there is no role check, because this writes nothing.
export const searchWithinMedia = async (req, res) => {
  const { q } = req.query;
  if (!q) throw badRequest("Query parameter 'q' is required");
  if (typeof q !== "string") throw badRequest("Query parameter 'q' must be a single value");
  const query = q.trim();
  if (!query) throw badRequest("Query parameter 'q' is required");
  if (query.length > MAX_QUERY_CHARS) {
    throw badRequest(`Search query must be at most ${MAX_QUERY_CHARS} characters`);
  }

  const results = await servicesDiscussion.searchWithinMedia(
    req.params.mediaId,
    query,
    await viewerScopeFor(req.user)
  );
  res.status(200).json(results);
};

// The caller's latest conversation on this lesson. Always the caller's own:
// the service is handed req.user.id, never an id from the request.
export const getConversation = async (req, res) => {
  const result = await servicesDiscussion.getLatestConversation(
    req.user.id,
    req.params.mediaId,
    await viewerScopeFor(req.user)
  );
  res.status(200).json(result);
};

// "שיחה חדשה". 201 when a row was created; 200 when the latest conversation was
// still empty and is handed back instead — the double-click case.
export const startConversation = async (req, res) => {
  const { created, ...result } = await servicesDiscussion.startConversation(
    req.user.id,
    req.params.mediaId,
    await viewerScopeFor(req.user)
  );
  res.status(created ? 201 : 200).json(result);
};

// A question is a sentence or a paragraph. The ceiling is generous for that,
// and it bounds what one request can add to a GPT-4o bill and to the stored
// conversation.
export const MAX_QUESTION_CHARS = 1000;

// The question from the body, checked — shared by both ways of asking.
const questionFrom = (req) => {
  const raw = req.body?.question;
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("'question' is required");
  const question = raw.trim();
  if (question.length > MAX_QUESTION_CHARS) {
    throw badRequest(`A question must be at most ${MAX_QUESTION_CHARS} characters`);
  }
  return question;
};

// Ask a question about this lesson. It always goes into the caller's latest
// conversation on it — there is no conversation id in the body to trust.
export const postMessage = async (req, res) => {
  const result = await servicesDiscussion.askInLesson({
    user: req.user,
    mediaId: req.params.mediaId,
    question: questionFrom(req),
    scope: await viewerScopeFor(req.user),
  });
  res.status(201).json(result);
};

// The same question, answered as it is written — Server-Sent Events.
//
// Everything that can refuse (400, 404, 409) runs BEFORE the event stream is
// opened, so a refusal is still an ordinary JSON error with its status code,
// handled by errorHandler like every other route. Once the stream is open the
// status is committed, and a failure becomes an `error` event instead.
//
//   event: delta  data: { text }                        what the gate let through
//   event: done   data: { conversation, messages }      the stored exchange
//   event: error  data: { code, message }               the answer failed
//
// A reader who leaves mid-answer aborts the OpenAI stream, and nothing is
// stored — the same as an answer that failed.
export const postMessageStream = async (req, res) => {
  const prepared = await servicesDiscussion.prepareAsk({
    user: req.user,
    mediaId: req.params.mediaId,
    question: questionFrom(req),
    scope: await viewerScopeFor(req.user),
  });

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // A reverse proxy that buffers would hold every event until the end.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await servicesDiscussion.streamAsk(prepared, {
      onDelta: (text) => send("delta", { text }),
      signal: abort.signal,
    });
    if (result) send("done", result);
  } catch (err) {
    // Only an AppError's code and message are the user's to see; anything
    // else is the generic failure, as errorHandler would have answered it.
    const known = err?.expose && err?.code;
    send("error", {
      code: known ? err.code : ERROR_CODES.AI_ANSWER_FAILED,
      message: known ? err.message : "The AI could not answer right now",
    });
  }
  res.end();
};
