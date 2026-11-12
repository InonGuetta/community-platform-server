// @ts-check
// Sending a stream as an HTTP response: reading the Range header, and piping
// with cleanup on both ends however the transfer ends. Nothing here knows what
// is being sent — controllers/controllersMediaFiles.js is the caller.
import { pipeline } from "stream/promises";
import { logger } from "./logger.js";

// The client hung up: the user seeked, closed the tab or navigated away. On a
// media player this is constant and completely normal, so it must not be logged
// as an error or the log fills with noise and hides the real failures.
const CLIENT_ABORT_CODES = new Set(["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE"]);
export const isClientAbort = (err) =>
  CLIENT_ABORT_CODES.has(err?.code) || err?.message === "aborted";

// Send a source stream to the response with cleanup on BOTH sides.
//
// .pipe() neither forwards errors nor destroys the source when the destination
// dies, so every seek or closed tab used to leave the file handle (or the S3
// socket) open — a steady leak on a server whose whole job is streaming media.
// pipeline() tears down both ends however it ends.
//
// By the time we get here the headers are already on the wire, so a failure can
// no longer become a JSON error response. Destroying the connection is the only
// correct move: the client sees a truncated response and retries the range.
export const streamToResponse = async (source, res, context) => {
  try {
    await pipeline(source, res);
  } catch (err) {
    if (isClientAbort(err)) {
      logger.debug(`[stream] client disconnected during ${context}`);
    } else {
      logger.error(`[stream] failed during ${context}: ${err.message}`);
    }
    res.destroy();
  }
};

// Returns null when there is no usable Range header, RANGE_UNSATISFIABLE when
// the request starts past the end of the file, or { start, end } otherwise.
//
// `end` is clamped to the last byte instead of rejected: RFC 9110 says a range
// overshooting the file is satisfied by what exists, and players routinely send
// a deliberately huge end value to mean "the rest". Answering 416 to those broke
// seeking. A suffix range ("bytes=-500" — the LAST 500 bytes) is also handled
// properly here; it used to be misread as "bytes=0-500".
// Exported for the range tests: the seek behaviour here is easy to break and
// the failure is a player that silently refuses to scrub.
export const RANGE_UNSATISFIABLE = Symbol("range-unsatisfiable");

export const parseRange = (header, size) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) return RANGE_UNSATISFIABLE;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return RANGE_UNSATISFIABLE;

  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return RANGE_UNSATISFIABLE;

  return { start, end };
};
