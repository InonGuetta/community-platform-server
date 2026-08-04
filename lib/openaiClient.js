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
