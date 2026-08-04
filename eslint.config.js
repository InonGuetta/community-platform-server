import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "uploads/**",
      "dist/**",

      // Throwaway probes at the repo root — `_probe.mjs`, `_inspect_tmp.mjs`
      // and friends. They are written to check one thing by hand and deleted,
      // they are never committed, and they are exactly where a bare console.log
      // belongs. Without this, one sitting in the working directory fails
      // `npm run lint` and turns CI red for a file that is not part of the app.
      // Narrow on purpose: only the root, only the leading underscore. Every
      // real module lives in a subdirectory.
      "_*.js",
      "_*.mjs",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // The logger exists so that verbosity is controllable with LOG_LEVEL and
      // so that every line carries a timestamp and the id of the request that
      // produced it. A direct console.* call has neither: it cannot be silenced
      // in production and it cannot be traced back to a request. This rule is
      // what stops one from being left behind after a debugging session — which
      // is the only way the logger stops being the single way this app logs.
      // lib/logger.js itself is exempted below.
      "no-console": "error",

      // Best-effort cleanup is a deliberate pattern here — a failed S3 delete
      // or unlink must not block the operation that triggered it — so an empty
      // catch is intent, not an oversight.
      "no-empty": ["error", { allowEmptyCatch: true }],

      // A leading underscore is the marker for "declared on purpose, unused":
      // Express hands middleware four arguments whether or not they are all
      // needed, and a caught error is often irrelevant to the recovery.
      "no-unused-vars": ["error", {
        args: "after-used",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",

        // `const { password_hash, ...safeUser } = user` and
        // `({ s3_key, ...rest }) => rest` are how secrets and internal storage
        // pointers are kept out of API responses. The named field is unused by
        // design — that is the whole point — so flagging it would push toward
        // renaming it to `_password_hash` and obscuring what is being stripped.
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // The logger is where console.* is the implementation rather than a
    // leftover. Scripts run from the terminal are the other legitimate case:
    // their output IS the user interface (a migration's progress, a dry run's
    // report), and routing it through a level-filtered logger would mean
    // `npm run migrate` printing nothing when LOG_LEVEL is set to warn.
    // Listed one by one rather than as db/*.js: that glob would also cover
    // db/pool.js, which is long-running application code and must keep going
    // through the logger like everything else.
    files: [
      "lib/logger.js",
      "db/migrate.js",
      "db/seed.js",
      "db/backfillEmbeddings.js",
      "db/migrateUploadsToS3.js",
      "db/closeStaleSessions.js",
      "db/publishExistingMedia.js",
      "scripts/**/*.js",
    ],
    rules: { "no-console": "off" },
  },
];
