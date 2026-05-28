import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

// Supabase silently drops idle connections, which the pool then hands out
// as dead sockets on the next request. keepAlive keeps the TCP channel
// alive; the timeouts make sure a dead/cold connection fails fast instead
// of hanging the request (which is what caused the ECONNRESET on first login).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  query_timeout: 15000,
});

// A pool-level error (e.g. an idle client dropped by Supabase) will crash the
// process if nothing listens. Log and swallow — the next acquire opens a fresh
// connection.
pool.on("error", (err) => {
  console.error("[pg pool] idle client error:", err.message);
});
