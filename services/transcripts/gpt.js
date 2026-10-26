// @ts-check
import { makeOpenAI } from "../../lib/openaiClient.js";

// The GPT client and model every stage in this folder shares.
//
// One place rather than four: analysis, the Hebrew correction, the headings and
// the search reranker all make the same two decisions, and before the split they
// happened to share one `const openai` because they happened to sit in one file.
// Copying that line into each module would have turned an incidental agreement
// into four independent ones, free to drift the first time somebody tuned a
// retry budget in the file they were looking at.
//
// 5 retries: these calls share the org's per-minute token budget. A call that
// trips the 30k TPM limit returns 429 + Retry-After; the SDK waits and retries,
// so batches self-pace. (The transcription worker deliberately uses fewer — see
// its header — which is why the budget is a per-caller argument at all.)
export const openai = makeOpenAI(5);

// The same model for calls a PERSON is waiting on: the search reranker and the
// "דיון עם AI" chat. The budget above is right for a worker that has all night
// and wrong for someone watching a spinner — with the account out of credit,
// every 429 was retried five times with backoff before the request gave up.
// Each caller here already has a fallback (the search keeps its fused order;
// the chat answers "try again"), so failing fast is the better outcome.
//
// 45 seconds still covers a full GPT-4o answer over ~25k tokens of lesson
// text; one retry still absorbs a single transient 5xx or rate-limit blip.
export const interactiveOpenai = makeOpenAI(1, 45 * 1000);

export const GPT_MODEL = "gpt-4o";
