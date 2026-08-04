// @ts-check
import { pool } from "../db/pool.js";

// The liveness probe's only dependency check.
//
// A service of its own rather than a line in servicesAdmin, which imports both
// Bull queues: /health has to answer while Redis is down, and putting it there
// would open two Redis connections on behalf of an endpoint that never uses
// them. It exists at all because `pool` belongs to the service layer — the
// check used to sit inline in the app, which was the one place in the codebase
// reaching past services to the database.
//
// Returns a boolean rather than throwing: "the database did not answer" is the
// result this endpoint reports, not an error in serving the request.
export const databaseReachable = async () => {
  await pool.query("SELECT 1");
  return true;
};
