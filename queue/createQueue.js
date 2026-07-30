import Bull from "bull";

if (!process.env.REDIS_URL) throw new Error("Missing REDIS_URL");

// Bull keeps every finished job forever by default, so Redis — an in-memory
// store — grew without bound for the life of the deployment. A bounded window
// instead of `true`: the admin dashboard reports completed/failed counts, and
// removing everything would make those permanently read zero.
const KEEP_FINISHED = { count: 50 };

// A job that is genuinely wedged must not hold the queue forever. This is a
// backstop, not a schedule: a three-hour lecture legitimately spends a long
// time in ffmpeg and then in a sequence of Whisper calls, so the value is
// deliberately far above any real run.
const DEFAULT_JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 4 * 60 * 60 * 1000;

export const createQueue = (name, jobOptions = {}) =>
  new Bull(name, process.env.REDIS_URL, {
    defaultJobOptions: {
      removeOnComplete: KEEP_FINISHED,
      removeOnFail: KEEP_FINISHED,
      timeout: DEFAULT_JOB_TIMEOUT_MS,
      ...jobOptions,
    },
  });
