import * as servicesSessions from "../services/servicesSessions.js";

export const createSession = async (req, res) => {
  try {
    const session = await servicesSessions.createSession(req.user.id, req.body);
    res.status(201).json(session);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

export const getActiveSessions = async (req, res) => {
  try {
    const sessions = await servicesSessions.getActiveSessions();
    res.status(200).json(sessions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getSessionById = async (req, res) => {
  try {
    const session = await servicesSessions.getSessionById(req.params.id);
    res.status(200).json(session);
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};

export const endSession = async (req, res) => {
  try {
    const session = await servicesSessions.endSession(req.params.id, req.user.id);
    res.status(200).json(session);
  } catch (err) {
    res.status(403).json({ message: err.message });
  }
};

export const saveRecording = async (req, res) => {
  try {
    const { s3Key } = req.body;
    const session = await servicesSessions.saveRecording(req.params.id, req.user.id, s3Key);
    res.status(200).json(session);
  } catch (err) {
    res.status(403).json({ message: err.message });
  }
};
