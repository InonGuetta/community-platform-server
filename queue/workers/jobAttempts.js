// @ts-check
// How many tries a job gets, and whether this one is its last.
//
// Both workers write a final status ('error') and tell the lecturer only on a
// job's last attempt. Written on an earlier one, the page stops polling and
// shows a failure — and when the retry succeeds a minute later, nobody is
// watching. Between attempts the row is left where it is, which keeps the page
// polling for the retry.

/**
 * The attempts this job was queued with (LLM_ATTEMPTS, TRANSCRIPTION_ATTEMPTS).
 * @param {{ opts?: { attempts?: number } }} job
 */
export const attemptsAllowed = (job) => job.opts?.attempts ?? 1;

/**
 * Whether the attempt now failing is the last one Bull will make. attemptsMade
 * counts the attempts already finished, not this one.
 * @param {{ attemptsMade: number, opts?: { attempts?: number } }} job
 */
export const isFinalAttempt = (job) => job.attemptsMade + 1 >= attemptsAllowed(job);
