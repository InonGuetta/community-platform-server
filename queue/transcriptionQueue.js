import { createQueue } from "./createQueue.js";

// Deliberately NO automatic retry by default, unlike the LLM queue.
//
// A transcription job has no checkpointing: if it fails after transcribing 15
// of 18 segments, a retry restarts from segment 1 and every one of those
// Whisper calls is billed again. That cost is only worth paying if retrying is
// likely to help, and here it usually isn't — the transient failures (a dropped
// connection, a 429) are already retried by the OpenAI SDK inside a single
// call, so what reaches this level is mostly deterministic: a corrupt file,
// ffmpeg refusing the input, an unreadable object. Retrying those just spends
// the money twice for the same failure.
//
// The job also fails loudly: status='error' shows in the UI and the lecturer
// can press "הפעל תמלול" again, which makes the retry a deliberate, informed
// choice rather than an automatic charge.
//
// Set TRANSCRIPTION_ATTEMPTS if you decide the convenience is worth the cost.
// Making retries genuinely cheap needs per-segment checkpointing, which is a
// redesign of the worker rather than a setting.
const ATTEMPTS = Number(process.env.TRANSCRIPTION_ATTEMPTS) || 1;

export const transcriptionQueue = createQueue("transcription", {
  attempts: ATTEMPTS,
  ...(ATTEMPTS > 1 && { backoff: { type: "exponential", delay: 60_000 } }),
});
