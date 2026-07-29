import { pool } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";

// Host and port only — REDIS_URL can carry a password.
const redisTarget = () => {
  try {
    const url = new URL(process.env.REDIS_URL);
    return `${url.hostname}:${url.port || 6379}`;
  } catch {
    return "the configured REDIS_URL";
  }
};

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "EAI_AGAIN"]);
const REPEAT_SUMMARY_MS = 30_000;

// Queue errors used to be logged as `queue error:` followed by err.message —
// which is empty for a connection failure, so an unreachable Redis produced an
// endless run of lines saying nothing at all. That is the single most likely
// thing to go wrong here, and it was the one case the log could not explain.
//
// Reports the cause and what it means, then goes quiet: Bull retries
// continuously, so without throttling this emits several lines a second and
// buries everything else in the terminal.
export const installQueueErrorLogging = (name, queue) => {
  let suppressed = 0;
  let lastReportedAt = 0;

  queue.on("error", (err) => {
    const now = Date.now();
    if (now - lastReportedAt < REPEAT_SUMMARY_MS) {
      suppressed++;
      return;
    }

    const alsoSuppressed = suppressed > 0 ? ` (${suppressed} identical since the last report)` : "";
    if (CONNECTION_CODES.has(err?.code)) {
      logger.error(
        `[WORKER:${name}] cannot reach Redis at ${redisTarget()} — ${err.code}. ` +
        `No jobs can be picked up until it is running.${alsoSuppressed}`
      );
    } else {
      logger.error(`[WORKER:${name}] queue error: ${err?.message || err?.code || err}${alsoSuppressed}`);
    }

    suppressed = 0;
    lastReportedAt = now;
  });
};

// Shared shutdown handling for the queue workers. The API server got this in
// wave 1; the workers were still killed outright.
//
// Why waiting matters more here than anywhere else: a worker killed mid-job
// leaves the job locked but unowned. Bull eventually marks it stalled and hands
// it to another worker, which restarts a transcription from segment one and
// pays for every Whisper call a second time. Letting the current job finish is
// almost always cheaper than the restart it avoids, so the grace period is
// generous rather than deploy-friendly.
//
// Practical consequence: deploy the workers when nothing is running, or expect
// the supervisor's own kill timeout to cut this short.
const GRACE_MS = Number(process.env.WORKER_SHUTDOWN_GRACE_MS) || 10 * 60 * 1000;

export const installWorkerLifecycle = (name, queue) => {
  let shuttingDown = false;

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[WORKER:${name}] ${reason} — letting the current job finish (up to ${GRACE_MS / 60000} min)`);

    const force = setTimeout(() => {
      logger.error(`[WORKER:${name}] grace period expired — exiting with a job still active`);
      process.exit(1);
    }, GRACE_MS);
    force.unref();

    try {
      // close() stops taking new jobs and resolves once the active one is done.
      await queue.close();
      await pool.end();
      logger.info(`[WORKER:${name}] shutdown complete`);
    } catch (err) {
      logger.error(`[WORKER:${name}] error during shutdown: ${err.message}`);
    }

    clearTimeout(force);
    process.exit(0);
  };

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => shutdown(signal));
  }

  process.on("unhandledRejection", (err) =>
    logger.error(`[WORKER:${name}] unhandledRejection:`, err?.stack || err)
  );
};
