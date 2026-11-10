// @ts-check
import OpenAI from "openai";
import { env } from "./env.js";
import { recordAiUsage } from "../services/servicesAiUsage.js";

// Single place the OpenAI client is configured. Callers pass the retry budget
// that suits their workload: the audio path uses fewer retries, the
// token-budget-sharing text/embedding paths use more so 429s self-pace via the
// SDK's Retry-After handling. Timeout defaults to a generous 5 minutes for long
// requests; a caller with a person waiting on the answer passes a short one.
export const makeOpenAI = (maxRetries = 5, timeoutMs = 5 * 60 * 1000) =>
  new OpenAI({
    apiKey: env.openaiApiKey,
    timeout: timeoutMs,
    maxRetries,
  });

// ── Metering (PRD ADM-1) ────────────────────────────────────────────────────
//
// Every module labels its client with what its calls are FOR, in one line:
//
//   const openai = meterOpenAI(baseClient, "hebrew_fix");
//
// The result has the client's shape for the three calls this server makes —
// chat completions, embeddings, audio transcriptions — calls straight through,
// and records the usage OpenAI reported (services/servicesAiUsage.js). A new call site
// cannot forget to record: there is no unmetered client left to call.
//
// The underlying method is looked up at CALL time, not captured, so a test that
// replaces `client.chat.completions.create` still reaches its stub.
//
// The recording is not awaited: it is one INSERT the caller has no use for, and
// the chat is answering someone who is watching. recordAiUsage never throws.
//
// `record` is a parameter only so a test can watch what is recorded.

/**
 * A streamed completion reports its usage only in a final chunk, and only when
 * asked to (`stream_options.include_usage`). This passes every chunk through
 * unchanged and records once the stream is over. A stream cut short — the
 * reader left, the request was aborted — never gets that chunk, and records
 * nothing rather than a guess.
 */
async function* meteredStream(stream, purpose, model, record) {
  let usage = null;
  let billedModel = model;
  for await (const chunk of stream) {
    if (chunk?.usage) usage = chunk.usage;
    if (chunk?.model) billedModel = chunk.model;
    yield chunk;
  }
  if (usage) {
    void record({ purpose, model: billedModel, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });
  }
}

/**
 * @param {any} client  from makeOpenAI
 * @param {string} purpose  what the calls are for — the line on the admin's screen
 * @param {(usage: any) => Promise<void>} [record]
 */
export const meterOpenAI = (client, purpose, record = recordAiUsage) => ({
  chat: {
    completions: {
      create: async (params, options) => {
        if (params?.stream) {
          const stream = await client.chat.completions.create(
            { ...params, stream_options: { ...params.stream_options, include_usage: true } },
            options
          );
          return meteredStream(stream, purpose, params.model, record);
        }
        const response = await client.chat.completions.create(params, options);
        void record({
          purpose,
          model: response?.model || params?.model,
          inputTokens: response?.usage?.prompt_tokens,
          outputTokens: response?.usage?.completion_tokens,
        });
        return response;
      },
    },
  },
  embeddings: {
    create: async (params, options) => {
      const response = await client.embeddings.create(params, options);
      void record({
        purpose,
        model: response?.model || params?.model,
        inputTokens: response?.usage?.prompt_tokens ?? response?.usage?.total_tokens,
      });
      return response;
    },
  },
  audio: {
    transcriptions: {
      // Whisper is billed by the minute of audio. verbose_json — what the
      // transcription worker asks for — reports the duration; any other format
      // does not, and is recorded at 0 seconds.
      create: async (params, options) => {
        const response = await client.audio.transcriptions.create(params, options);
        void record({ purpose, model: params?.model, audioSeconds: Number(response?.duration) || 0 });
        return response;
      },
    },
  },
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
