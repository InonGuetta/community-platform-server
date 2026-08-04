// @ts-check
// An operational error whose message is safe to show the client, carrying the
// HTTP status to return. The error handler sends AppError.message as-is but
// hides the message of any other (unexpected) error behind a generic 500, so
// raw DB/internal errors never leak to clients.
//
// `code` is the stable, machine-readable half of that contract. The message is
// English prose meant for a human, and the client already has to translate it to
// Hebrew — which it does by matching the exact English string
// (SERVER_MESSAGE_HE in the client's notificationMiddleware). That coupling
// means rewording a message here silently breaks the translation there, with no
// error anywhere: the user just starts seeing the generic fallback again.
// Branching on the code instead leaves the wording free to change.
export class AppError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

// The default code names the class of failure; pass a specific one when the
// caller can say something more precise than "not found" (e.g. EMAIL_TAKEN
// rather than the bare CONFLICT).
export const notFound = (message = "Not found", code = "NOT_FOUND") =>
  new AppError(message, 404, code);
export const badRequest = (message = "Bad request", code = "BAD_REQUEST") =>
  new AppError(message, 400, code);
export const unauthorized = (message = "Unauthorized", code = "UNAUTHORIZED") =>
  new AppError(message, 401, code);
export const forbidden = (message = "Forbidden", code = "FORBIDDEN") =>
  new AppError(message, 403, code);
export const conflict = (message, code = "CONFLICT") =>
  new AppError(message, 409, code);

// Codes produced by the error handler itself rather than by a thrown AppError.
export const ERROR_CODES = {
  DB_UNAVAILABLE: "DB_UNAVAILABLE",
  INTERNAL: "INTERNAL_ERROR",
};
