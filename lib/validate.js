// @ts-check
import { badRequest } from "./AppError.js";

// Small hand-rolled guards, deliberately not a validation library: they exist
// to turn client input that Postgres would reject (and surface as a confusing
// 500) into a clear 400. Adopting a schema validator is a separate decision.

// Seconds into a recording: a position, a bookmark, a note timestamp.
// null is rejected explicitly because Number(null) is 0 — without this a
// missing position would silently save as "back to the start".
export const requireSeconds = (value, name) => {
  if (value === null || value === undefined || value === "") {
    throw badRequest(`${name} is required`);
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw badRequest(`${name} must be a non-negative number`);
  }
  return Math.floor(seconds);
};

// Same, but the field may be omitted entirely (stored as NULL).
export const optionalSeconds = (value, name) =>
  value === undefined || value === null ? null : requireSeconds(value, name);

// A foreign key coming from the client. Postgres would reject a non-numeric id
// with "invalid input syntax for integer".
export const optionalId = (value, name) => {
  if (value === undefined || value === null) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`${name} must be a positive integer`);
  return id;
};

export const optionalBoolean = (value, name) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw badRequest(`${name} must be a boolean`);
  return value;
};
