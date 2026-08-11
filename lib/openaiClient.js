// @ts-check
import OpenAI from "openai";

// Single place the OpenAI client is configured. Callers pass the retry budget
// that suits their workload: the audio path uses fewer retries, the
// token-budget-sharing text/embedding paths use more so 429s self-pace via the
// SDK's Retry-After handling. Timeout is a generous 5 minutes for long requests.
export const makeOpenAI = (maxRetries = 5) =>
  new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 5 * 60 * 1000,
    maxRetries,
  });

// ── Reading a completion back ───────────────────────────────────────────────
//
// `response.choices[0].message.content` is not the guarantee it looks like.
// `choices` comes back empty on some upstream failures, and `content` is null
// whenever the model refuses or the response is cut short by a content filter or
// the token ceiling. Every call site used to reach straight through that chain,
// so those cases surfaced as `Cannot read properties of null (reading 'trim')` —
// thrown up to an hour into a transcription, naming neither which of the six
// OpenAI calls in this pipeline failed nor why.
//
// `context` is what makes the difference: it is the caller's own name, so the
// log line identifies the stage. `finish_reason` is the field that says WHICH of
// the causes above it was ("content_filter", "length", "stop" with empty text).
//
// The model's text is never included in the error. It is a summary of, or a
// correction to, a transcript — the same content db/pool.js withholds query
// parameters for. Length and finish_reason identify the failure without it.
export const completionText = (response, context) => {
  const choice = response?.choices?.[0];
  if (!choice) {
    throw new Error(`${context}: OpenAI returned no choices`);
  }
  const content = choice.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      `${context}: OpenAI returned no usable text ` +
      `(finish_reason=${choice.finish_reason ?? "unknown"}, length=${content?.length ?? 0})`
    );
  }
  return content.trim();
};

// The JSON-mode equivalent. `response_format: { type: "json_object" }` makes
// valid JSON very likely but not certain — a response truncated by the token
// limit is cut mid-object and parses as nothing at all.
//
// The parser's own message is kept because it is structural, not content:
// "Unexpected token ` in JSON at position 0" is precisely how a stray markdown
// fence announces itself, and it reveals no more of the text than that.
export const completionJson = (response, context) => {
  const text = completionText(response, context);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${context}: OpenAI returned unparseable JSON (${err.message}, length=${text.length})`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${context}: OpenAI returned JSON that is not an object`);
  }
  return parsed;
};
