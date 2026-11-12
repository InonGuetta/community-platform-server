// @ts-check
import { pool } from "./pool.js";

/**
 * Runs `work` as one transaction on a client of its own: BEGIN, then COMMIT if
 * `work` resolves or ROLLBACK if it throws, and the client goes back to the
 * pool either way. Resolves to whatever `work` returned; rejects with whatever
 * it threw.
 *
 * Everything inside `work` must go through the `client` it is handed. A
 * pool.query in there runs on another connection, outside the transaction —
 * it neither sees the uncommitted rows nor is undone by the rollback.
 *
 * A ROLLBACK that itself fails is swallowed, so the caller sees the error that
 * caused it. The connection is often the very thing that failed, and a
 * rollback error in its place would report "connection terminated" for a
 * request that was really a duplicate (23505) or a 404.
 *
 * The statements are exactly "BEGIN", "COMMIT" and "ROLLBACK", and pool.connect
 * is read on every call rather than captured: test/setup.js (stubPoolConnect)
 * and scripts/smoke.js both swap pool.connect for a stand-in, and smoke maps
 * those three strings onto savepoints so nothing it runs survives.
 *
 * @template T
 * @param {(client: any) => Promise<T>} work
 * @returns {Promise<T>}
 */
export const withTransaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
