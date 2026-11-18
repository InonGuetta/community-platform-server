// @ts-check
// What the end-to-end test needs that no screen can give it (PRD NFR-9).
//
//   node scripts/e2eFixtures.js setup             → prints { runId, admin }
//   node scripts/e2eFixtures.js teardown <runId>  → deletes that run's data
//   node scripts/e2eFixtures.js phone <runId>     → prints { phone } — a mobile
//        number for this run, refused if any account outside the run has it
//   node scripts/e2eFixtures.js phone-code <runId> <email>
//        → prints { code } — puts a known code in place of the one an e2e
//          account is waiting for (the real one went to the server's log)
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
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/transaction.js";
import { env } from "../lib/env.js";
import { isLocalKey, removeStored } from "../lib/storage.js";

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
    // Local files only: an S3 object the run uploaded is left where it is, as it
    // always was.
    if (isLocalKey(key)) await removeStored(key, { missingOk: true });
  }
  out({ runId, users: removed, courses, media: media.length, notices });
};

// A phone number for this run (PRD AUTH-13): 054-5 and six digits from the
// run id — and refused when any account outside this run has it, verified or
// waiting, since proving a number another account verified MOVES it here.
const runPhone = (runId) => `+972545${String(parseInt(runId.slice(0, 8), 16) % 1_000_000).padStart(6, "0")}`;
const phone = async (runId) => {
  if (!RUN_ID.test(runId ?? "")) throw new Error(`not a run id: ${runId}`);
  const number = runPhone(runId);
  const pattern = `e2e-%-${runId}@example.test`;
  const { rows } = await pool.query(
    `SELECT 1 FROM users WHERE phone_e164 = $1 AND email NOT LIKE $2
     UNION ALL
     SELECT 1 FROM phone_verifications v JOIN users u ON u.id = v.user_id
      WHERE v.phone_e164 = $1 AND u.email NOT LIKE $2`,
    [number, pattern]
  );
  if (rows.length) throw new Error(`${number} belongs to an account outside this run — not using it`);
  out({ phone: number });
};

// Only an account of this run, and only the code it is already waiting for.
const phoneCode = async (runId, email) => {
  if (!RUN_ID.test(runId ?? "")) throw new Error(`not a run id: ${runId}`);
  if (!new RegExp(`^e2e-[a-z]+-${runId}@example\\.test$`).test(email ?? "")) throw new Error(`not this run's account: ${email}`);
  const { hashCode } = await import("../services/servicesPhone.js");
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const { rows } = await pool.query(
    "SELECT v.user_id, v.phone_e164 FROM phone_verifications v JOIN users u ON u.id = v.user_id WHERE u.email = $1",
    [email]
  );
  if (!rows[0]) throw new Error(`${email} is not waiting for a code`);
  await pool.query("UPDATE phone_verifications SET code_hash = $1 WHERE user_id = $2", [
    hashCode(rows[0].user_id, rows[0].phone_e164, code),
    rows[0].user_id,
  ]);
  out({ code });
};

const main = async () => {
  if (env.isProduction) throw new Error("e2e fixtures never run against production");
  const [command, runId, extra] = process.argv.slice(2);
  if (command === "setup") await setup();
  else if (command === "teardown") await teardown(runId);
  else if (command === "phone") await phone(runId);
  else if (command === "phone-code") await phoneCode(runId, extra);
  else throw new Error("usage: e2eFixtures.js setup | teardown <runId> | phone <runId> | phone-code <runId> <email>");
};

main()
  .catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
