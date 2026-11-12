// @ts-check
import { ERROR_CODES } from "../lib/AppError.js";

// The roles travel on the middleware as `allowedRoles`. test/roleMatrix.test.js
// walks every mounted route and compares the roles it actually admits with the
// matrix written down there; without the label a role check is an anonymous
// closure, and the only way to learn what it allows is to call it.
export const requireRole = (...roles) =>
  Object.assign(
    (req, res, next) => {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ message: "Forbidden", code: ERROR_CODES.FORBIDDEN });
      }
      next();
    },
    { allowedRoles: Object.freeze([...roles]) }
  );
