// @ts-check
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// A rate limit counted per SIGNED-IN USER, for routes that sit behind
// verifyToken.
//
// The default key is the client IP, which is the wrong unit for this audience:
// a yeshiva shares one public address, so an IP budget is the budget of the whole
// building, while one person with a phone and a laptop gets two. After
// verifyToken the caller is known, and that is what should be counted.
//
// Falls back to the IP (through express-rate-limit's own helper, which groups an
// IPv6 address by subnet) only if mounted somewhere req.user is not set — a
// mistake, but not one that should disable the limit.
export const userRateLimit = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message },
    // req.user is attached by verifyToken; express's Request type does not know
    // it, and the rest of the codebase reads it from untyped handler params.
    keyGenerator: (req) => {
      const userId = /** @type {{ user?: { id?: number } }} */ (/** @type {unknown} */ (req)).user?.id;
      return userId ? `user:${userId}` : ipKeyGenerator(req.ip ?? "");
    },
  });
