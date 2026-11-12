// @ts-check
// A Word document (.docx) as a page the reader can show in its frame:
// converted by mammoth, then sanitised, because the file is untrusted user
// content and the result is served as text/html.
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import { badRequest, ERROR_CODES } from "./AppError.js";

/** @param {Buffer} buffer */
export const convertWordToHtml = async (buffer) => {
  // mammoth throws from inside the zip reader on a file that is corrupt,
  // truncated, or simply not the DOCX it claims to be. That is a problem with
  // THIS FILE, not with the server, and it arrived as a 500 — which reads as a
  // fault and tells the user nothing they can act on. Same treatment, and the
  // same wording, that lib/textExtract.js already gives the extraction path.
  let rawHtml;
  try {
    ({ value: rawHtml } = await mammoth.convertToHtml({ buffer }));
  } catch (err) {
    throw badRequest(
      `Could not read this document — it may be corrupt or password-protected. (${err.message})`,
      ERROR_CODES.DOCUMENT_UNREADABLE
    );
  }
  // The DOCX is untrusted user content and we serve the result as text/html, so
  // sanitize before embedding: strip scripts/styles/handlers, keep only safe
  // formatting tags. Allow data: image URIs since mammoth inlines images.
  const html = sanitizeHtml(rawHtml, {
    allowedTags: [
      "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
      "ul", "ol", "li", "strong", "em", "b", "i", "u", "sup", "sub", "a",
      "img", "table", "thead", "tbody", "tr", "td", "th", "span",
    ],
    allowedAttributes: { a: ["href", "title"], img: ["src", "alt"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
  });
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:sans-serif;line-height:1.6;padding:24px;max-width:800px;margin:0 auto}</style>
</head><body>${html}</body></html>`;
};
