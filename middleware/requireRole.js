// @ts-check
import { ERROR_CODES } from "../lib/AppError.js";

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Forbidden", code: ERROR_CODES.FORBIDDEN });
  }
  next();
};
