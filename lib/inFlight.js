import { conflict } from "./AppError.js";

// Stops the same expensive operation running twice concurrently for the same
// subject. The AI endpoints run synchronously inside the request and take
// minutes on a long transcript, which is exactly long enough for a user to
// press the button again — and each press is a full sequence of paid GPT-4o
// calls.
//
// LIMITATION: this is per-process. It is correct for the single API server this
// app runs today; if it is ever scaled to multiple instances, the guarantee has
// to move to Redis or a database lock, because each process would keep its own
// set and let one request through per instance.
const running = new Map();

export const withExclusive = async (key, fn, message = "Operation already in progress") => {
  if (running.has(key)) throw conflict(message, "ALREADY_RUNNING");
  running.set(key, true);
  try {
    return await fn();
  } finally {
    running.delete(key);
  }
};
