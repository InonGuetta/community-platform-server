import { logger } from "./logger.js";

const isBlank = (name) => !process.env[name]?.trim();

// Fail fast, and fail ONCE: report every missing variable together so a fresh
// setup is fixed in a single pass instead of one reboot per variable.
export const requireEnv = (names) => {
  const missing = names.filter(isBlank);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
      `Copy .env.example to .env and fill them in.`
    );
  }
};

// Not fatal, but the feature each one powers is silently degraded. Say so at
// boot instead of letting it surface later as a confusing runtime failure.
export const warnMissingEnv = (consequenceByName) => {
  for (const [name, consequence] of Object.entries(consequenceByName)) {
    if (isBlank(name)) logger.warn(`${name} is not set — ${consequence}`);
  }
};
