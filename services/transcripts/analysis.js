// @ts-check
// AI analysis: a transcript in, { summary, key_points } out.
//
// Shared by the LLM worker (auto, after transcription) and by the headings
// feature (on demand, if the auto step failed or was skipped). Short transcripts
// go to GPT in one call; long ones are condensed batch-by-batch first (map) and
// the batch summaries analysed together (reduce), so no single call exceeds the
// TPM limit — which is what silently broke multi-hour lectures.
import { logger } from "../../lib/logger.js";
import { completionText, completionJson } from "../../lib/openaiClient.js";
import { openai, GPT_MODEL } from "./gpt.js";

const ANALYSIS_BATCH_WORDS = 5000;

const ANALYSIS_MAP_PROMPT = `אתה מקבל קטע מתוך תמלול של הרצאה/שיעור בעברית. סכם בעברית, ב-3–4 משפטים, את התוכן המרכזי של הקטע הזה בלבד. החזר טקסט רגיל בלבד, בלי כותרות ובלי markdown.`;

// How many key points a transcript of `wordCount` words warrants. The count
// scales with length so a 3-hour lecture (~22k words) gets ~10–15 sections, not
// a fixed 3, while a short clip stays at 3. The model picks the exact number
// within this range based on how many distinct topics actually exist.
//
// A book is where the previous version broke down. It clamped `max` to 20 but
// derived `min` from the raw length, so a 250k-word book produced min=136 with
// max=20 — and the prompt then asked the model for "between 136 and 20 points",
// which is not a range at all. `max` is now computed first and `min` is clamped
// beneath it, so the pair is ordered for any length.
const MAX_KEY_POINTS = 20;
// Books get a higher ceiling than lectures: 20 points over 400 pages is a table
// of contents with most of the chapters missing.
export const MAX_KEY_POINTS_TEXT = 30;

// Exported for headings.js, which asks the same question of an EXISTING set of
// key points — "are there as many as this length warrants?" — to decide whether
// to re-analyse. It has to be the same function or the two answers drift and a
// transcript oscillates between being re-analysed and not.
export const keyPointRange = (wordCount, cap = MAX_KEY_POINTS) => {
  const target = Math.round(wordCount / 1800);
  const max = Math.min(cap, Math.max(5, target + 3));
  const min = Math.max(3, Math.min(target - 2, max - 2));
  return { min, max };
};

// Built per call so the requested count tracks the transcript's length.
const analysisPrompt = (min, max) => `אתה מנתח תוכן מומחה. תקבל תמלול של הרצאה/שיעור בעברית (או תקצירים מסודרים שלו לפי הסדר).
החזר אובייקט JSON עם השדות הבאים בדיוק — כל הטקסט (summary, key_points) חייב להיות **בעברית**:
{
  "summary": "פסקה תמציתית של 3–5 משפטים המסכמת את התוכן העיקרי",
  "key_points": ["נקודה מרכזית 1", "נקודה מרכזית 2", "..."]
}
לגבי key_points: החזר בין ${min} ל-${max} נקודות מפתח — כמספר הנושאים/הקטעים המובחנים שבאמת קיימים בתוכן, לפי סדר הופעתם. אל תמתח או תמציא נקודות סתם כדי למלא, אבל אם יש הרבה נושאים — פרט אותם ואל תצטמצם ל-3.
שמות השדות נשארים באנגלית (summary, key_points). רק הערכים בעברית.
החזר רק JSON תקין — בלי markdown, בלי הסברים, בלי \`\`\`.`;

const summarizeBatch = async (text) => {
  const r = await openai.chat.completions.create({
    model: GPT_MODEL,
    messages: [
      { role: "system", content: ANALYSIS_MAP_PROMPT },
      { role: "user", content: text },
    ],
  });
  return completionText(r, "analyzeTranscript/map");
};

// How many map calls may be in flight at once.
//
// The map stage used to be a plain sequential loop, which is fine for the six
// batches a long lecture produces and painful for the fifty a book produces —
// fifty round trips end to end is most of an hour. Concurrency is bounded
// rather than unbounded because these calls share the org's per-minute token
// budget: three 5,000-word batches in flight is ~22k tokens against a 30k TPM
// limit, so this stays under it in the normal case and the SDK's Retry-After
// handling absorbs the rest.
const MAP_CONCURRENCY = Number(process.env.LLM_MAP_CONCURRENCY) || 3;

// A ceiling on the fold below, purely as a stop against a pathological input
// that somehow never shrinks. Two levels already cover a 250k-word book.
const MAX_FOLD_DEPTH = 4;

// Run `fn` over `items` with at most `limit` concurrent calls, preserving input
// order in the output. Order matters: the partial summaries are fed back to the
// model as a sequential account of the text, so shuffling them would scramble
// the narrative and the order of the key points derived from it.
// `aborted` is what stops the OTHER runners once one of them throws. Promise.all
// rejects on the first failure but does nothing to the runners still looping, so
// without this a book whose third batch fails goes on to buy the remaining
// forty-seven GPT calls for a result the caller has already abandoned — and each
// late rejection arrives with nobody left to receive it, i.e. an
// unhandledRejection that names none of this.
const mapWithConcurrency = async (items, limit, fn) => {
  const results = new Array(items.length);
  let cursor = 0;
  let aborted = false;
  const runner = async () => {
    while (!aborted) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
};

const splitIntoBatches = (words, size) => {
  const batches = [];
  for (let i = 0; i < words.length; i += size) {
    batches.push(words.slice(i, i + size).join(" "));
  }
  return batches;
};

// Condense text to a shorter text of ordered partial summaries.
const foldOnce = async (text, depth) => {
  const batches = splitIntoBatches(text.split(/\s+/), ANALYSIS_BATCH_WORDS);
  logger.debug(`[BE:svc] analyzeTranscript — fold ${depth}: ${batches.length} batch(es), concurrency ${MAP_CONCURRENCY}`);
  let done = 0;
  const partials = await mapWithConcurrency(batches, MAP_CONCURRENCY, async (batch) => {
    const summary = await summarizeBatch(batch);
    logger.debug(`[BE:svc]   fold ${depth}: ${++done}/${batches.length} ✓`);
    return summary;
  });
  return partials.join("\n\n");
};

// `keyPointCap` lets a book ask for more sections than a lecture; everything
// else about the analysis is identical for both.
export const analyzeTranscript = async (rawText, keyPointCap = MAX_KEY_POINTS) => {
  const wordCount = rawText.trim() ? rawText.trim().split(/\s+/).length : 0;
  const { min, max } = keyPointRange(wordCount, keyPointCap);

  // Fold REPEATEDLY rather than once. One pass was enough for a lecture, and in
  // practice is still enough for most books — 50 batches condense to ~3k words,
  // which fits. But that is a property of how tersely the model happens to
  // summarise, not a guarantee, and the single-pass version had no recourse if
  // the condensed text was still too long: it sent it anyway and the call died
  // on the token limit. Looping costs nothing when one pass suffices and is the
  // difference between working and failing when it does not.
  let input = rawText;
  let depth = 0;
  while (
    (input.trim() ? input.trim().split(/\s+/).length : 0) > ANALYSIS_BATCH_WORDS &&
    depth < MAX_FOLD_DEPTH
  ) {
    input = await foldOnce(input, ++depth);
  }
  if (depth > 0) {
    logger.debug(`[BE:svc] analyzeTranscript — ${wordCount} words condensed in ${depth} fold(s) → ${input.split(/\s+/).length} words`);
  }

  const r = await openai.chat.completions.create({
    model: GPT_MODEL,
    messages: [
      { role: "system", content: analysisPrompt(min, max) },
      { role: "user", content: input },
    ],
    response_format: { type: "json_object" },
  });

  // Validate the SHAPE, not just the syntax. Both callers write this straight to
  // the database, and the LLM worker sets status='done' in the same UPDATE — so
  // a response that parsed but carried no `summary` stored a NULL summary and
  // then advertised the row as finished, which is the exact "silent success"
  // that `analyzing` was introduced to prevent. Failing here instead routes it
  // through the worker's catch: status='error', visible in the UI, retryable.
  const parsed = completionJson(r, "analyzeTranscript");
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("analyzeTranscript: response has no `summary`");
  }
  if (!Array.isArray(parsed.key_points) || parsed.key_points.length === 0) {
    throw new Error("analyzeTranscript: response has no `key_points`");
  }
  return parsed;
};
