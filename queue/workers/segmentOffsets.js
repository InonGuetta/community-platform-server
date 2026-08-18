// @ts-check
// Where each audio segment begins on the original recording.
//
// Its own module because importing transcriptionWorker.js STARTS a worker — it
// registers a queue processor, opens Redis and sweeps the temp directory — so
// the one piece here that can quietly be wrong could not otherwise be tested at
// all. Same trade the client makes with stageGeometry.js and mediaErrors.js: the
// rule moves somewhere it can be driven directly, the plumbing stays put.
//
// What it parses is ffmpeg's segment list. The offsets were previously computed
// as `index * SEGMENT_SECONDS`, which is not true of the files ffmpeg actually
// writes: the muxer cuts on a frame boundary, so each piece runs a little past
// the requested length and the excess accumulates in one direction down the
// recording. Nothing measured it; the number was assumed. Asking the muxer to
// report its own boundaries (`-segment_list ... -segment_list_type csv`) replaces
// the assumption with the answer, from the same pass that did the cutting.

// One row per segment: filename,start,end — in seconds, as decimals.
//
// Returns null rather than a partial answer when the list does not describe
// exactly the segments on disk. The caller then falls back to the old
// arithmetic: a job that has already paid for its transcoding must not die
// because an ffmpeg build formatted its list differently, and being no worse
// than before is an acceptable floor. Being SILENTLY wrong is not, which is why
// a short, over-long or unparseable list is rejected outright instead of being
// padded out to fit.
export const parseSegmentStarts = (csv, expectedCount) => {
  const rows = String(csv ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (rows.length !== expectedCount) return null;

  const starts = rows.map((line) => Number(line.split(",")[1]));
  if (!starts.every((n) => Number.isFinite(n) && n >= 0)) return null;

  // The list is written in the order the segments were produced, and the
  // timeline only moves forwards. Anything else means this is not the file we
  // think it is, and using it would scatter every timestamp in the transcript.
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] <= starts[i - 1]) return null;
  }

  // A recording starts at zero. A first row that does not is the strongest
  // available signal that the columns are not the ones assumed here.
  if (starts[0] !== 0) return null;

  return starts;
};

// What the offsets were before ffmpeg was asked: an even division, correct only
// for the first segment. Kept as the fallback, and named so the log line and the
// tests can say which of the two produced a given set of timestamps.
export const assumedSegmentStarts = (count, segmentSeconds) =>
  Array.from({ length: count }, (_, i) => i * segmentSeconds);
