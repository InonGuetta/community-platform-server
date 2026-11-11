// @ts-check
import jwt from "jsonwebtoken";
import { getActiveUserById, tokenPredatesPasswordChange } from "../services/servicesAuth.js";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";

// Pull the JWT out of the handshake's Cookie header (the same httpOnly `token`
// cookie the REST API uses). The client connects same-origin, so the browser
// sends it automatically — no token handling needed on the client side.
const tokenFromHandshake = (socket) => {
  const raw = socket.handshake.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "token") return decodeURIComponent(rest.join("="));
  }
  return null;
};

// Reject unauthenticated sockets before any signalling can flow. The verified
// identity — not client-supplied values — is what gets relayed to the room.
//
// A valid signature is NOT sufficient, and the second step is why. The token
// lasts seven days and carries a snapshot of the role it was minted with, so on
// signature alone a user who was deactivated or demoted keeps whatever they had
// until it expires. verifyToken has re-read the row on every REST request from
// the beginning for exactly this reason; this side was trusting the claims, so
// closing an account shut the API to them while leaving their live signalling
// connection — and their ability to end a session they host — untouched.
//
// Same lookup as the REST path, from the same function, so the two cannot answer
// differently. Exported so the rule can be tested without standing up a server.
export const authenticateSocket = async (socket, next) => {
  const token = tokenFromHandshake(socket);
  if (!token) {
    logger.debug("[socket] handshake rejected: no token cookie");
    return next(new Error("Unauthorized"));
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    logger.debug("[socket] handshake rejected: invalid token");
    return next(new Error("Unauthorized"));
  }

  try {
    const user = await getActiveUserById(payload.id);
    if (!user) {
      logger.debug("[socket] handshake rejected: no active user behind the token");
      return next(new Error("Unauthorized"));
    }
    // The same rule verifyToken applies: a token older than the last password
    // change is spent. Without it a stolen cookie kept opening signalling
    // connections for the rest of its seven days after the owner reset their
    // password — the exact case the REST check exists for.
    if (tokenPredatesPasswordChange(user, payload.iat)) {
      logger.debug("[socket] handshake rejected: token predates the last password change");
      return next(new Error("Unauthorized"));
    }
    // The row, not the token's claims — a role changed since the token was signed
    // takes effect on the next connection rather than on expiry. The display name
    // rides along so chat messages can say who wrote them.
    socket.user = { id: user.id, role: user.role, displayName: user.display_name ?? null };
    next();
  } catch (err) {
    // The database being unreachable is not the caller's fault, but a handshake
    // has no way to say "try again later". Logged at error so a burst of refusals
    // during an outage is distinguishable from genuine rejections, which are debug.
    logger.error(`[socket] handshake failed to verify user: ${err.message}`);
    next(new Error("Unauthorized"));
  }
};
