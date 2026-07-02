// An operational error whose message is safe to show the client, carrying the
// HTTP status to return. The error handler sends AppError.message as-is but
// hides the message of any other (unexpected) error behind a generic 500, so
// raw DB/internal errors never leak to clients.
export class AppError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

export const notFound = (message = "Not found") => new AppError(message, 404);
export const badRequest = (message = "Bad request") => new AppError(message, 400);
export const unauthorized = (message = "Unauthorized") => new AppError(message, 401);
export const forbidden = (message = "Forbidden") => new AppError(message, 403);
export const conflict = (message, code) => new AppError(message, 409, code);
