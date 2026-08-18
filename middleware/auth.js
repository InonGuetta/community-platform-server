// @ts-check
import jwt from "jsonwebtoken";
import { getActiveUserById, tokenPredatesPasswordChange } from "../services/servicesAuth.js";
import { env } from "../lib/env.js";
import { ERROR_CODES } from "../lib/AppError.js";

// Verify the JWT, then re-check the user against the DB on every request. The
// token is valid for 7 days and carries a role snapshot; without this lookup a
// user who was deactivated (is_active=FALSE) or whose role was changed would
// keep their old access until the token expired. Fetching the live row also
// means downstream handlers always see the current role, not a stale one.
export const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ message: "Unauthorized", code: ERROR_CODES.UNAUTHORIZED });
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    return res.status(401).json({ message: "Invalid token", code: ERROR_CODES.INVALID_TOKEN });
  }

  try {
    // Shared with the socket handshake rather than written out here — see
    // getActiveUserById for why one copy of this question is load-bearing.
    const user = await getActiveUserById(payload.id);
    if (!user) {
      return res.status(401).json({ message: "Unauthorized", code: ERROR_CODES.UNAUTHORIZED });
    }

    // A token older than the last password change is spent, whatever its expiry
    // says. This is what makes "reset my password" end a compromise instead of
    // merely inconveniencing it — see tokenPredatesPasswordChange.
    if (tokenPredatesPasswordChange(user, payload.iat)) {
      return res.status(401).json({
        message: "Session ended because the password was changed",
        code: ERROR_CODES.INVALID_TOKEN,
      });
    }

    // password_changed_at is fetched for the check above and is nobody's
    // business downstream — req.user is what handlers read as the caller's
    // identity, and it has never carried anything but these three.
    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
};
