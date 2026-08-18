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

// Every code this API can return, in one list.
//
// This is the stable half of the error contract described above, and the client
// mirrors it in store/middleware/notificationMiddleware.js to pick the Hebrew it
// shows the user. Two rules keep that mirror honest:
//
//   * A code is never renamed or reused. Rewording a message is free — that is
//     the entire point — but a code is an identifier the other repository holds.
//   * A code is only worth adding when the client would say something SPECIFIC
//     about it. The generic five below are the default for everything else, and
//     the client falls back to a per-action message ("loading the media failed")
//     that already carries the context.
//
// The specific ones exist because the generic ones are too coarse to translate:
// four different NOT_FOUNDs deserve four different sentences, and before this
// the client told them apart by matching the exact English prose — which broke
// silently the first time a message was reworded.
export const ERROR_CODES = {
  // Generic — the default carried by each AppError helper.
  NOT_FOUND: "NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",

  // Produced by the error handler itself rather than by a thrown AppError.
  DB_UNAVAILABLE: "DB_UNAVAILABLE",
  INTERNAL: "INTERNAL_ERROR",

  // Authentication.
  INVALID_TOKEN: "INVALID_TOKEN",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  LAST_ACTIVE_ADMIN: "LAST_ACTIVE_ADMIN",

  // Account recovery. All three earn a code because the user can act on each,
  // and the actions differ: ask for a new link, choose a longer password, or
  // sign in with Google instead.
  INVALID_RESET_TOKEN: "INVALID_RESET_TOKEN",
  WEAK_PASSWORD: "WEAK_PASSWORD",
  NO_PASSWORD_SET: "NO_PASSWORD_SET",

  // A standing order, which the form can ask for and the platform cannot yet
  // take. Specific because the user CAN act on it — give once instead — and a
  // generic "donation failed" would send them away thinking it was broken.
  RECURRING_UNAVAILABLE: "RECURRING_UNAVAILABLE",

  // Resources the client names individually.
  MEDIA_NOT_FOUND: "MEDIA_NOT_FOUND",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_FORBIDDEN: "SESSION_FORBIDDEN",
  // Scheduled but not yet opened by its host. Specific because the user can act
  // on it — wait, or come back — which is a different instruction from "gone".
  SESSION_NOT_STARTED: "SESSION_NOT_STARTED",
  BOOKMARK_NOT_FOUND: "BOOKMARK_NOT_FOUND",
  NOTE_NOT_FOUND: "NOTE_NOT_FOUND",
  COURSE_NOT_FOUND: "COURSE_NOT_FOUND",
  TRANSCRIPT_NOT_FOUND: "TRANSCRIPT_NOT_FOUND",

  // A saved-lessons list whose name the user already used. Specific rather than
  // the bare CONFLICT because the client has something precise to say about it:
  // the name is the only thing wrong, and a generic "creating the list failed"
  // leaves the user retrying the same name.
  PLAYLIST_TITLE_TAKEN: "PLAYLIST_TITLE_TAKEN",

  // The transcript pipeline, where the reason is usually something the user can
  // act on — which is exactly when a precise message earns its keep.
  NO_TRANSCRIPT_TEXT: "NO_TRANSCRIPT_TEXT",
  NO_TRANSCRIPT_CONTENT: "NO_TRANSCRIPT_CONTENT",
  NO_KEY_POINTS: "NO_KEY_POINTS",
  UNSUPPORTED_TEXT_FORMAT: "UNSUPPORTED_TEXT_FORMAT",
  ALREADY_QUEUED: "ALREADY_QUEUED",
  ALREADY_RUNNING: "ALREADY_RUNNING",
};
