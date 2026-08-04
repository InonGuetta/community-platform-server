// Extract text from a document and print it — nothing else.
//
//   npm run extract:preview -- "C:/path/to/book.pdf"
//   npm run extract:preview -- ./book.pdf 4000     (show more characters)
//
// This exists because the expensive, slow, irreversible part of summarising a
// book is everything AFTER extraction, and the part most likely to be wrong is
// extraction itself. Hebrew in a PDF can come out with the letters reversed, the
// niqqud shredded, or a commentary column woven through the main text — and none
// of that is visible from a summary that reads plausibly.
//
// So: no database, no Redis, no OpenAI, no cost. Point it at a real book, read
// the output, and only then run the real thing.

import path from "path";
import { readFile } from "fs/promises";
import { extractDocumentText, countWords } from "../lib/textExtract.js";
import { chunkTextByParagraph } from "../lib/textChunks.js";

const DEFAULT_PREVIEW_CHARS = 1500;

const main = async () => {
  const [filePath, previewArg] = process.argv.slice(2);
  if (!filePath) {
    console.error("Usage: npm run extract:preview -- <file> [previewChars]");
    process.exit(1);
  }

  const previewChars = Number(previewArg) || DEFAULT_PREVIEW_CHARS;
  const absolute = path.resolve(filePath);

  let buffer;
  try {
    buffer = await readFile(absolute);
  } catch (err) {
    console.error(`✗ Could not read ${absolute}\n  ${err.message}`);
    process.exit(1);
  }

  console.log(`file      ${absolute}`);
  console.log(`size      ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  let result;
  try {
    result = await extractDocumentText(buffer, absolute);
  } catch (err) {
    // This is the tool working, not failing: the quality gate rejected the file
    // and said why, which is exactly what the pipeline would have told the user.
    console.error(`\n✗ REJECTED — ${err.message}`);
    process.exit(2);
  }

  const { text, words, pageCount, extension } = result;
  const chunks = chunkTextByParagraph(text);
  const chunkWords = chunks.map((c) => countWords(c.content));

  console.log(`format    .${extension}`);
  console.log(`pages     ${pageCount || "n/a"}`);
  console.log(`chars     ${text.length.toLocaleString()}`);
  console.log(`words     ${words.toLocaleString()}`);
  console.log(`chunks    ${chunks.length}` +
    (chunks.length ? ` (min ${Math.min(...chunkWords)}, max ${Math.max(...chunkWords)} words)` : ""));

  // A rough cost/time signal before committing to a paid run: the analysis maps
  // over ~5,000-word batches, and that batch count is what drives both.
  console.log(`llm calls ~${Math.ceil(words / 5000) + 1} (map batches + 1 final)`);

  console.log(`\n${"─".repeat(60)}\nFIRST ${previewChars} CHARACTERS\n${"─".repeat(60)}`);
  console.log(text.slice(0, previewChars));

  if (text.length > previewChars) {
    console.log(`\n${"─".repeat(60)}\nLAST 500 CHARACTERS\n${"─".repeat(60)}`);
    console.log(text.slice(-500));
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log("Read the Hebrew above. If the letters run the wrong way, words are");
  console.log("glued together, or a commentary column is mixed into the main text,");
  console.log("STOP — summarising this file would produce confident nonsense.");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
