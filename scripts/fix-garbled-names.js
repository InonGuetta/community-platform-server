// @ts-check
// One-off repair (UI_UX_FIXES 5.3): display names stored without their encoding.
//
//   npm run fix:garbled-names -- --dry   → lists the accounts, and what it would do
//   npm run fix:garbled-names            → repairs the ones whose name is known
//
// A Hebrew name sent from a terminal whose code page is not UTF-8 reached the
// JSON parser as invalid bytes, each turned into U+FFFD, and was stored that
// way. servicesAuth.cleanDisplayName now refuses such a name, so no new row can
// hold one; this repairs the rows stored before.
//
// The original letters are gone — the replacement character is all that was
// stored — so a name can only be put back where it is KNOWN. One is: the
// notification test accounts (notif-test-<n>@example.test, account 9) were
// registered with "משתמש בדיקה להתראות", which is on record in the command
// that made them. Any other garbled name is listed and left alone, for a person
// to correct from the users screen.
//
// Safe to run again: the repair re-checks the mark, so a second run changes
// nothing.
import "dotenv/config";
import { pool } from "../db/pool.js";
import { findGarbledDisplayNames, repairGarbledDisplayName } from "../services/servicesUsers.js";

const dryRun = process.argv.includes("--dry");

const KNOWN_NAMES = [
  { email: /^notif-test-\d+@example\.test$/, name: "משתמש בדיקה להתראות" },
];
const knownNameFor = (email) => KNOWN_NAMES.find((k) => k.email.test(email ?? ""))?.name ?? null;

// An address is personal data: enough of it to recognise a test account, no
// more (the domain, and the local part's first letters).
const maskEmail = (email) => {
  const [local = "", domain = ""] = String(email ?? "").split("@");
  return `${local.slice(0, 11)}…@${domain}`;
};

const run = async () => {
  const rows = await findGarbledDisplayNames();
  if (rows.length === 0) {
    console.log("No display name holds a replacement character.");
    return;
  }

  console.log(`${rows.length} account(s) with a garbled display name:`);
  const plan = rows.map((r) => ({ ...r, repair: knownNameFor(r.email) }));
  for (const r of plan) {
    const what = r.repair ? `→ ${JSON.stringify(r.repair)}` : "left alone (the original name is not known)";
    console.log(`  #${r.id}  ${maskEmail(r.email)}  ${r.is_active ? "active" : "inactive"}  ${what}`);
  }

  const repairs = plan.filter((r) => r.repair);
  if (dryRun) {
    console.log(`\n--dry: nothing was changed. A real run repairs ${repairs.length} of ${rows.length}.`);
    return;
  }

  let repaired = 0;
  for (const r of repairs) {
    if (await repairGarbledDisplayName(r.id, /** @type {string} */ (r.repair))) repaired += 1;
  }
  console.log(`\nRepaired ${repaired} display name(s); ${rows.length - repaired} left as they are.`);
};

run()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
