import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "uploads/**", "dist/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
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
];
