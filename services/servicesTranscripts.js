// @ts-check
// The transcripts service: one resource, one entry point, a module per concern.
//
//   transcripts/status.js     transcripts.status — the UI's contract — written here only
//   transcripts/chunks.js     the transcript row and its chunks: read/write
//   transcripts/pipeline.js   putting work on the queues + reconciliation
//   transcripts/gpt.js        the shared GPT clients + model
//   transcripts/analysis.js   transcript → { summary, key_points }
//   transcripts/hebrew.js     correcting Yiddish-accented Hebrew, on demand
//   transcripts/headings.js   placing the key points on the timeline
//   transcripts/aiActions.js  the two above as queued work with a status
//   transcripts/search.js     keyword / semantic / hybrid + LLM rerank
//   transcripts/tagging.js    tags the LLM proposes from the summary (imported directly)
//   transcripts/questions.js  the chat's starting questions (imported directly)
//
// Re-export rather than a move, deliberately. `controllersTranscripts.js` does
// `import * as servicesTranscripts` and both workers import named functions from
// here; a barrel keeps every one of those untouched, which is what made the
// split a change with no behaviour in it and therefore reviewable by reading the
// diff. It also keeps the servicesXxx.js-per-resource convention true from the
// outside — a new reader still finds the transcripts service where the other ten
// services are.
//
// Adding to this feature: put it in the module that owns the concern and export
// it here. A concern that does not read or write a transcript is the signal to
// ask whether it belongs here at all.

export {
  markPending,
  markProcessing,
  markAnalyzing,
  markDone,
  markDoneUnlessAnalyzing,
  markFailed,
} from "./transcripts/status.js";

export {
  saveChunks,
  saveTextChunks,
  getTranscriptByMediaId,
  getTranscriptText,
  updateTranscript,
  getChunkForAnchor,
  getChunkContaining,
} from "./transcripts/chunks.js";

export { analyzeTranscript, MAX_KEY_POINTS_TEXT } from "./transcripts/analysis.js";

export { fixHebrewTranscript } from "./transcripts/hebrew.js";

export { generateKeyPointHeadings } from "./transcripts/headings.js";

// The two above, as queued work with a status (PIPE-5): the request claims and
// queues, the LLM worker runs.
export { requestAiAction, runAiAction, AI_ACTIONS, AI_ACTION_STALE_MINUTES } from "./transcripts/aiActions.js";

export { triggerPipeline, reconcileMissingTranscripts, queueLlmForMedia } from "./transcripts/pipeline.js";

export { searchTranscripts } from "./transcripts/search.js";
