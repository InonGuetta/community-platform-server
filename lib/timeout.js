// @ts-check

/**
 * Settles as `promise` does, or rejects with `new Error(message)` once `ms`
 * pass without an answer.
 *
 * For calls that have no deadline of their own and hang rather than fail when
 * what they talk to has gone — a Bull add() or getJob() with Redis down waits
 * for a connection that is not coming.
 *
 * The timer is cleared as soon as the race is decided, so it never outlives
 * the call it guards. It is deliberately NOT unref'd: a deadline must fire even
 * when nothing else is holding the event loop open, or the caller would wait
 * for an answer that never comes. The abandoned call is still observed by the
 * race, so a late rejection from it is never unhandled.
 *
 * @template T
 * @param {Promise<T> | T} promise
 * @param {number} ms
 * @param {string} [message]  what the rejection says — it reaches the logs
 */
export const withTimeout = (promise, ms, message = "timeout") => {
  let timer;
  const deadline = /** @type {Promise<never>} */ (new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  }));
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};
