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

// The largest value an INT4 column holds. Every id in this schema is SERIAL,
// which is INT4 — so a number above this is not "an id we do not have", it is a
// value the column cannot store, and Postgres answers "value out of range for
// type integer". That surfaces as a 500, which is the same confusing failure the
// non-numeric case was already guarded against. Exported because the route-param
// guard needs the identical bound: an id can arrive in the path or in the body,
// and guarding only one door leaves the other open.
export const PG_INT_MAX = 2147483647;

// A foreign key coming from the client. Postgres would reject a non-numeric id
// with "invalid input syntax for integer", and one over PG_INT_MAX with an
// out-of-range error.
export const optionalId = (value, name) => {
  if (value === undefined || value === null) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > PG_INT_MAX) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return id;
};

// The largest list of ids a single request may carry. Nothing here is a
// pagination boundary — it is the point past which a request stops being a user
// action and starts being a way to make the server build a very large array
// from a very small body. A notebook of a thousand notes is already far past
// anything a person scrolls through by hand.
export const MAX_ID_LIST = 1000;

// An ORDERED list of ids — the notebook's drag-to-reorder sends one per drop.
//
// Duplicates are rejected rather than tolerated. Postgres would accept them and
// update the same row twice with two different positions, picking a winner by
// nothing in particular; a list that names a note twice is a client bug and the
// useful answer is to say so, not to store an order that depends on which
// duplicate the planner reached last.
export const requireIdList = (value, name) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(`${name} must be a non-empty array of ids`);
  }
  if (value.length > MAX_ID_LIST) {
    throw badRequest(`${name} must hold at most ${MAX_ID_LIST} ids`);
  }
  const ids = value.map((entry) => {
    const id = Number(entry);
    if (!Number.isInteger(id) || id <= 0 || id > PG_INT_MAX) {
      throw badRequest(`${name} must contain positive integers only`);
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw badRequest(`${name} must not contain the same id twice`);
  }
  return ids;
};

export const optionalBoolean = (value, name) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw badRequest(`${name} must be a boolean`);
  return value;
};
