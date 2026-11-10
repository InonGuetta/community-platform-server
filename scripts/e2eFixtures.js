// @ts-check
// What the end-to-end test needs that no screen can give it (PRD NFR-9).
//
//   node scripts/e2eFixtures.js setup             → prints { runId, admin }
//   node scripts/e2eFixtures.js teardown <runId>  → deletes that run's data
//
// The journey under test starts with a lecturer signing up and an ADMIN
// approving them, and an admin cannot be made through the app. So each run
// makes its own: a throwaway admin with a random password, printed once for
// the test and never stored anywhere else. Nobody's real account or password
// is involved.
//
// Every account a run creates — this admin, and the lecturer and student the
// test signs up through the screens — has an address of the form
// e2e-<who>-<runId>@example.test. Teardown deletes exactly those accounts and
// what they own (their courses, which take enrolments and join requests with
// them; their uploads, files included), and nothing else: the pattern is
// matched on the runId, which must be the hex this script generated.
//
// Refuses to run with NODE_ENV=production.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/transaction.js";
import { env } from "../lib/env.js";
import { LOCAL_UPLOAD_DIR } from "../lib/storage.js";

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

export const e2eEmail = (who, runId) => `e2e-${who}-${runId}@example.test`;
const RUN_ID = /^[a-f0-9]{10}$/;

const setup = async () => {
  const runId = randomBytes(5).toString("hex");
  const password = randomBytes(18).toString("base64url");
  const email = e2eEmail("admin", runId);
  await pool.query(
    `INSERT INTO users (email, password_hash, role, display_name, email_verified)
     VALUES ($1, $2, 'admin', $3, TRUE)`,
    [email, await bcrypt.hash(password, 10), `מנהל בדיקה ${runId}`]
  );
  out({ runId, admin: { email, password } });
};

const teardown = async (runId) => {
  if (!RUN_ID.test(runId ?? "")) throw new Error(`not a run id: ${runId}`);
  const { media, courses, notices, removed } = await withTransaction(async (client) => {
    const { rows: users } = await client.query(
      "SELECT id FROM users WHERE email LIKE $1",
      [`e2e-%-${runId}@example.test`]
    );
    const ids = users.map((u) => u.id);
    const { rows: deletedMedia } = await client.query(
      "DELETE FROM media_items WHERE uploader_id = ANY($1::int[]) RETURNING s3_key",
      [ids]
    );
    const { rowCount: deletedCourses } = await client.query("DELETE FROM courses WHERE lecturer_id = ANY($1::int[])", [ids]);
    // Notices ABOUT this run's people that went to somebody else — the role
    // request the lecturer's sign-up sends every admin, real ones included. A
    // user's own notifications go with the user; these would otherwise sit in
    // a real admin's bell, naming an account that no longer exists.
    const { rowCount: deletedNotices } = await client.query(
      `DELETE FROM notifications
        WHERE payload->>'email' LIKE $1 OR payload->>'userId' = ANY($2::text[])`,
      [`e2e-%-${runId}@example.test`, ids.map(String)]
    );
    const { rowCount: deletedUsers } = await client.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]);
    return { media: deletedMedia, courses: deletedCourses, notices: deletedNotices, removed: deletedUsers };
  });

  // The files after the rows: a file left behind is litter, a row pointing
  // at a deleted file is a broken lesson.
  for (const { s3_key: key } of media) {
    if (typeof key === "string" && key.startsWith("local/")) {
      await fs.rm(path.join(LOCAL_UPLOAD_DIR, key.slice("local/".length)), { force: true });
    }
  }
  out({ runId, users: removed, courses, media: media.length, notices });
};

const main = async () => {
  if (env.isProduction) throw new Error("e2e fixtures never run against production");
  const [command, runId] = process.argv.slice(2);
  if (command === "setup") await setup();
  else if (command === "teardown") await teardown(runId);
  else throw new Error("usage: e2eFixtures.js setup | teardown <runId>");
};

main()
  .catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
