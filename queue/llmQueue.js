import Bull from "bull";

if (!process.env.REDIS_URL) throw new Error("Missing REDIS_URL");

export const llmQueue = new Bull("llm", process.env.REDIS_URL);
