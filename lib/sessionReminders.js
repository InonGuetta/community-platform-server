// @ts-check
// The timer behind LIVE-6: once a minute, remind the audience of every session
// that is about to begin. The work — and the guarantee that each session is
// reminded once — is servicesNotifications.sendDueSessionReminders; this only
// runs it.
//
// In the API server rather than a worker: the workers exist to drain Redis
// queues and stop with them, and a reminder must not depend on Redis being up.
// Several API servers may each run it; the claim in the UPDATE makes that safe.
import { sendDueSessionReminders } from "../services/servicesNotifications.js";
import { logger } from "./logger.js";

export const REMINDER_TICK_MS = 60_000;

/** @returns {() => void} stops the timer */
export const startSessionReminders = () => {
  const tick = async () => {
    const sent = await sendDueSessionReminders();
    if (sent > 0) logger.info(`[reminders] reminded ${sent} session(s)`);
  };
  const timer = setInterval(() => { void tick(); }, REMINDER_TICK_MS);
  // Never what keeps the process alive — shutdown must not wait a minute for it.
  timer.unref();
  void tick();
  return () => clearInterval(timer);
};
