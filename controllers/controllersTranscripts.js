import * as servicesTranscripts from "../services/servicesTranscripts.js";

export const getTranscript = async (req, res) => {
  const { mediaId } = req.params;
  console.log(`[BE:ctrl] GET /transcripts/${mediaId} user=${req.user?.id}`);
  try {
    const transcript = await servicesTranscripts.getTranscriptByMediaId(mediaId);
    console.log(`[BE:ctrl] GET /transcripts/${mediaId} ✓ status=${transcript.status} chunks=${transcript.chunks?.length ?? 0}`);
    res.status(200).json(transcript);
  } catch (err) {
    console.log(`[BE:ctrl] GET /transcripts/${mediaId} ✗ ${err.message}`);
    res.status(404).json({ message: err.message });
  }
};

export const updateTranscript = async (req, res) => {
  const { mediaId } = req.params;
  console.log(`[BE:ctrl] PUT /transcripts/${mediaId} user=${req.user?.id}`);
  try {
    const transcript = await servicesTranscripts.updateTranscript(mediaId, req.body);
    console.log(`[BE:ctrl] PUT /transcripts/${mediaId} ✓`);
    res.status(200).json(transcript);
  } catch (err) {
    console.log(`[BE:ctrl] PUT /transcripts/${mediaId} ✗ ${err.message}`);
    res.status(400).json({ message: err.message });
  }
};

export const triggerPipeline = async (req, res) => {
  const { mediaId } = req.params;
  console.log(`[BE:ctrl] POST /transcripts/${mediaId}/trigger user=${req.user?.id}`);
  try {
    const result = await servicesTranscripts.triggerPipeline(mediaId);
    console.log(`[BE:ctrl] POST /transcripts/${mediaId}/trigger ✓ jobId=${result.jobId}`);
    res.status(200).json(result);
  } catch (err) {
    console.log(`[BE:ctrl] POST /transcripts/${mediaId}/trigger ✗ ${err.message}`);
    res.status(400).json({ message: err.message });
  }
};

export const fixHebrew = async (req, res) => {
  const { mediaId } = req.params;
  console.log(`[BE:ctrl] POST /transcripts/${mediaId}/fix-hebrew user=${req.user?.id}`);
  try {
    const transcript = await servicesTranscripts.fixHebrewTranscript(mediaId);
    console.log(`[BE:ctrl] POST /transcripts/${mediaId}/fix-hebrew ✓`);
    res.status(200).json(transcript);
  } catch (err) {
    console.log(`[BE:ctrl] POST /transcripts/${mediaId}/fix-hebrew ✗ ${err.message}`);
    res.status(400).json({ message: err.message });
  }
};

export const generateKeyPointHeadings = async (req, res) => {
  const { mediaId } = req.params;
  console.log(`[BE:ctrl] POST /transcripts/${mediaId}/key-point-headings user=${req.user?.id}`);
  try {
    const transcript = await servicesTranscripts.generateKeyPointHeadings(mediaId);
    console.log(`[BE:ctrl] POST /transcripts/${mediaId}/key-point-headings ✓`);
    res.status(200).json(transcript);
  } catch (err) {
    console.log(`[BE:ctrl] POST /transcripts/${mediaId}/key-point-headings ✗ ${err.message}`);
    res.status(400).json({ message: err.message });
  }
};

const SEARCH_MODES = new Set(["keyword", "semantic", "hybrid"]);

export const searchTranscripts = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ message: "Query parameter 'q' is required" });
    // Default to hybrid; ignore anything unrecognised rather than 400 so a stray
    // mode value can't break search.
    const mode = SEARCH_MODES.has(req.query.mode) ? req.query.mode : "hybrid";
    const results = await servicesTranscripts.searchTranscripts(q, mode);
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
