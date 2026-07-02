import jwt from "jsonwebtoken";
import { pool } from "../db/pool.js";

// Verify the JWT, then re-check the user against the DB on every request. The
// token is valid for 7 days and carries a role snapshot; without this lookup a
// user who was deactivated (is_active=FALSE) or whose role was changed would
// keep their old access until the token expired. Fetching the live row also
// means downstream handlers always see the current role, not a stale one.
export const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }

  try {
    const result = await pool.query(
      "SELECT id, email, role FROM users WHERE id=$1 AND is_active=TRUE",
      [payload.id]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    next(err);
  }
};
