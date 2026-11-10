// The server's own source files, read as text — for the guard tests that check
// a rule holds across the whole tree (one definition of a helper, one place
// that opens a transaction). It holds no tests: `node --test` loads it anyway,
// as it loads setup.js, and finds nothing to run.
import { readdir, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_DIRS = ["controllers", "services", "lib", "middleware", "sockets", "queue", "routes", "db", "scripts", "config"];

const jsFilesUnder = async (dir) => {
  const entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await jsFilesUnder(rel)));
    else if (entry.name.endsWith(".js")) files.push(rel);
  }
  return files;
};

/**
 * Every .js file under the server's source directories (not test/), as
 * { file, source } with `file` relative to the package root.
 * @returns {Promise<Array<{ file: string, source: string }>>}
 */
export const serverSourceFiles = async () => {
  const files = (await Promise.all(SOURCE_DIRS.map(jsFilesUnder))).flat();
  return Promise.all(files.map(async (file) => ({ file, source: await readFile(path.join(ROOT, file), "utf8") })));
};
