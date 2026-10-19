// @ts-check
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { logger } from "./logger.js";

// How long a recording is, in whole seconds.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// media_items.duration_seconds has been in the schema since migration 002 and
// nothing ever wrote it: the upload form does not send it and the server never
// measured it, so every row holds NULL. Filtering the archive by length needs it
// to be TRUE, which means measured from the file rather than taken from the
// browser — a client-reported duration is whatever the client says.
//
// ── Why ffmpeg and not ffprobe ──────────────────────────────────────────────
//
// ffprobe is the tool built for this, and it is not installed: ffmpeg-static
// ships ffmpeg alone. Adding ffprobe-static would be a second ~70MB binary to
// answer one question that ffmpeg already answers. `ffmpeg -i <file>` with no
// output prints the container's header to stderr — including a line
//
//     Duration: 01:12:34.56, start: 0.000000, bitrate: 64 kb/s
//
// — and then exits with an error because no output was named. The exit code is
// therefore meaningless here and is ignored; the Duration line is the answer.
//
// ── Never fatal ─────────────────────────────────────────────────────────────
//
// Every failure — no binary, a corrupt file, a format with no duration in its
// header ("Duration: N/A", a live stream), a probe that hangs — answers null.
// Callers store null and move on. An upload must never fail because its length
// could not be read: the file is the thing of value, the length is a convenience.

// ffmpeg-static's default export is the binary's path (or null on a platform it
// has no build for). Its declaration says so, but under this project's module
// settings the checker resolves the default import of that CommonJS package to
// the module object instead, so the value is restated as what it is at runtime.
const FFMPEG = /** @type {string | null} */ (/** @type {unknown} */ (ffmpegPath));

const PROBE_TIMEOUT_MS = 30_000;

// The longest stderr worth holding. The Duration line is in the first few
// hundred bytes; a file with hundreds of streams can print far more, and none of
// that is needed.
const MAX_STDERR_CHARS = 64 * 1024;

const DURATION_LINE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/**
 * The duration ffmpeg reports in its header output, in whole seconds — or null
 * when there is no usable one. Exported for the tests: this is the part with
 * edge cases, and it can be checked without running ffmpeg at all.
 *
 * @param {string} stderr
 * @returns {number | null}
 */
export const parseDurationSeconds = (stderr) => {
  const match = DURATION_LINE.exec(String(stderr ?? ""));
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  // Rounded rather than floored: a 59.6-second clip is "a minute", and a filter
  // boundary is a minute mark, so the nearer whole second is the honest one.
  const rounded = Math.round(total);
  // Zero is not a length — it is a header that claims nothing.
  return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
};

/**
 * Measure a file on disk. Resolves to whole seconds or null; never rejects.
 *
 * @param {string} filePath
 * @returns {Promise<number | null>}
 */
export const probeDurationSeconds = (filePath) =>
  new Promise((resolve) => {
    if (!FFMPEG || !filePath) {
      resolve(null);
      return;
    }

    let stderr = "";
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    const finish = (value, why) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (value === null && why) logger.debug(`[duration] no length for ${filePath}: ${why}`);
      resolve(value);
    };

    let child;
    try {
      // -hide_banner keeps the build information out of the output; -i alone,
      // with no output file, reads the header and stops.
      child = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-i", filePath], { windowsHide: true });
    } catch (err) {
      finish(null, err.message);
      return;
    }

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, `ffmpeg did not answer within ${PROBE_TIMEOUT_MS}ms`);
    }, PROBE_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString();
    });
    child.on("error", (err) => finish(null, err.message));
    child.on("close", () => {
      const seconds = parseDurationSeconds(stderr);
      finish(seconds, seconds === null ? "no Duration line in the header" : null);
    });
  });
