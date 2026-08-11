// @ts-check
// The transcripts service. One resource, six concerns, one entry point.
//
// This file used to BE all of them — 968 lines holding the GPT analysis, the
// Hebrew correction, the headings, the chunk writer, the queue trigger and a
// three-mode search engine. Every other file in services/ is 130–160 lines; this
// was the one that had to be read end to end to find out what was in it.
//
//   transcripts/gpt.js        the shared GPT client + model
//   transcripts/analysis.js   transcript → { summary, key_points }
//   transcripts/hebrew.js     correcting Yiddish-accented Hebrew, on demand
//   transcripts/headings.js   placing the key points on the timeline
//   transcripts/chunks.js     the transcript row and its chunks: read/write
//   transcripts/pipeline.js   putting work on the queues + reconciliation
//   transcripts/search.js     keyword / semantic / hybrid + LLM rerank
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
// it here. Adding a SEVENTH concern is the signal to ask whether it belongs to
// transcripts at all.

export {
  saveChunks,
  saveTextChunks,
  getTranscriptByMediaId,
  getTranscriptText,
  updateTranscript,
} from "./transcripts/chunks.js";

export { analyzeTranscript, MAX_KEY_POINTS_TEXT } from "./transcripts/analysis.js";

export { fixHebrewTranscript } from "./transcripts/hebrew.js";

export { generateKeyPointHeadings } from "./transcripts/headings.js";

export { triggerPipeline, reconcileMissingTranscripts } from "./transcripts/pipeline.js";

export { searchTranscripts } from "./transcripts/search.js";
