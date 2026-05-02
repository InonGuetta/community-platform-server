import * as servicesTranscripts from "../services/servicesTranscripts.js";

export const getTranscript = async (req, res) => {
  try {
    const transcript = await servicesTranscripts.getTranscriptByMediaId(req.params.mediaId);
    res.status(200).json(transcript);
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};

export const updateTranscript = async (req, res) => {
  try {
    const transcript = await servicesTranscripts.updateTranscript(req.params.mediaId, req.body);
    res.status(200).json(transcript);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

export const triggerPipeline = async (req, res) => {
  try {
    const result = await servicesTranscripts.triggerPipeline(req.params.mediaId);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

export const searchTranscripts = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ message: "Query parameter 'q' is required" });
    const results = await servicesTranscripts.searchTranscripts(q);
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
