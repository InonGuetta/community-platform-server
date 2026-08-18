// @ts-check
import { PG_INT_MAX } from "../lib/validate.js";

// Guard for numeric route params (our ids are SERIAL/INT). Without this a
// non-numeric id like /api/media/abc reaches Postgres as "invalid input syntax
// for integer" and surfaces as a confusing 500. Reject it early with a clean 400.
//
// The digit test alone was not enough, and the gap was the same 500 this exists
// to prevent: /api/media/99999999999 is all digits, so it passed — and then
// Postgres answered "value out of range for type integer" because SERIAL is
// INT4. Zero is rejected for the same family of reasons: no SERIAL ever issues
// it, so it can only be a malformed request, and letting it through spends a
// query to discover that.
//
// The bound is shared with lib/validate.js rather than restated here. An id
// reaches this application through a path param or through a JSON body, and a
// guard that covers one door while the other stays open is not a guard.
export const validateIntParam = (name) => (req, res, next) => {
  const value = req.params[name];
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > PG_INT_MAX) {
    return res.status(400).json({ message: `Invalid ${name}` });
  }
  next();
};
