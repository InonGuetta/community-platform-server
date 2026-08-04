// @ts-check
import * as servicesSessions from "../services/servicesSessions.js";
import { badRequest } from "../lib/AppError.js";

// Mirrors the session_type enum from migration 003. Without this check an
// unknown value reaches Postgres as "invalid input value for enum" and surfaces
// as a 500 instead of a 400.
const SESSION_TYPES = new Set(["1on1", "group", "webinar"]);
const TITLE_MAX = 255; // matches VARCHAR(255)
const MAX_PARTICIPANTS_CEILING = 100;

export const createSession = async (req, res) => {
  const { title, sessionType, maxParticipants } = req.body ?? {};

  // Title stays optional — the column is nullable and the sessions list already
  // renders "מפגש ללא כותרת" — so requiring it here would break a flow that
  // works today.
  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  if (trimmedTitle.length > TITLE_MAX) throw badRequest(`Title must be at most ${TITLE_MAX} characters`);

  if (!SESSION_TYPES.has(sessionType)) throw badRequest(`Invalid session type: "${sessionType}"`);

  let participants = null;
  if (maxParticipants !== undefined && maxParticipants !== null) {
    participants = Number(maxParticipants);
    if (!Number.isInteger(participants) || participants < 1 || participants > MAX_PARTICIPANTS_CEILING) {
      throw badRequest(`maxParticipants must be a whole number between 1 and ${MAX_PARTICIPANTS_CEILING}`);
    }
  }

  const session = await servicesSessions.createSession(req.user.id, {
    title: trimmedTitle || null,
    sessionType,
    maxParticipants: participants,
  });
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

// The client supplies this key and it is stored verbatim, so it must not be
// able to point outside the bucket's normal namespace: whatever eventually
// serves recordings would otherwise inherit a path-traversal hole. Restricted
// to S3-safe characters with no parent-directory segments.
const SAFE_S3_KEY = /^[A-Za-z0-9!_.*'()/-]{1,512}$/;

export const saveRecording = async (req, res) => {
  const { s3Key } = req.body ?? {};
  if (typeof s3Key !== "string" || !SAFE_S3_KEY.test(s3Key) || s3Key.includes("..")) {
    throw badRequest("Invalid recording key");
  }
  const session = await servicesSessions.saveRecording(req.params.id, req.user.id, s3Key);
  res.status(200).json(session);
};
