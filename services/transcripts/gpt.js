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

export const GPT_MODEL = "gpt-4o";
