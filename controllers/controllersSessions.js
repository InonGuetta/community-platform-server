import * as servicesSessions from "../services/servicesSessions.js";

export const createSession = async (req, res) => {
  const session = await servicesSessions.createSession(req.user.id, req.body);
  res.status(201).json(session);
};

export const getActiveSessions = async (req, res) => {
  const sessions = await servicesSessions.getActiveSessions();
  res.status(200).json(sessions);
};

export const getSessionById = async (req, res) => {
  const session = await servicesSessions.getSessionById(req.params.id);
  res.status(200).json(session);
};

export const endSession = async (req, res) => {
  const session = await servicesSessions.endSession(req.params.id, req.user.id);
  res.status(200).json(session);
};

export const saveRecording = async (req, res) => {
  const { s3Key } = req.body;
  const session = await servicesSessions.saveRecording(req.params.id, req.user.id, s3Key);
  res.status(200).json(session);
};
