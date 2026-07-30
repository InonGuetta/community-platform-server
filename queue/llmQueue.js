import { createQueue } from "./createQueue.js";

// Retries ARE worth it here, unlike the transcription queue.
//
// This job re-reads the transcript and re-runs the analysis from the start, so
// it is naturally idempotent, and it costs a fraction of a transcription — a
// handful of GPT-4o calls against a text that is already saved, versus a full
// pass of Whisper over the audio. A failure is also more damaging to leave
// alone: the transcript lands with status='error' and no summary at all, even
// though the expensive work already succeeded.
//
// Exponential backoff starting at a minute so a rate limit or a brief upstream
// outage resolves itself instead of burning all three attempts in seconds.
const ATTEMPTS = Number(process.env.LLM_ATTEMPTS) || 3;

export const llmQueue = createQueue("llm", {
  attempts: ATTEMPTS,
  backoff: { type: "exponential", delay: 60_000 },
});
