// @ts-check
// A public lesson, for a guest with the link (PRD COM-3b, COM-4): its page's
// data and the link preview a share opens with. Mounted by
// routes/routersPublic.js; the lesson's recording and file for the guest are
// streamPublicMedia, in controllersMediaFiles.js, with the other byte routes.
import * as servicesMedia from "../services/servicesMedia.js";
import { escapeHtml } from "../lib/html.js";
import { env } from "../lib/env.js";
import { notFound, ERROR_CODES } from "../lib/AppError.js";

// ── A public lesson, for a guest with the link (PRD COM-3b, COM-4) ──────────
//
// No session on any of these: the link is meant to be opened by someone who
// has never signed up. What makes it safe is the row — public AND published,
// checked on every request by getPublicMedia — and how little is sent: the
// recording, the summary and the key points. A lesson that is not public is
// the same 404 as one that does not exist.

const publicLesson = ({ s3_key, ...lesson }) => lesson;

export const getPublicLesson = async (req, res) => {
  const lesson = await servicesMedia.getPublicMedia(req.params.id);
  if (!lesson) throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  res.status(200).json(publicLesson(lesson));
};

// What a WhatsApp (or any) link preview reads. Crawlers do not run the app's
// JavaScript, so the share link is this small server-rendered page: Open Graph
// tags naming the lesson, then an immediate redirect to the guest page in the
// app. For a lesson that is not public it names nothing — a generic card — and
// redirects all the same, so the link reveals no title it should not.
const excerpt = (text, max = 200) => {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export const sharePage = async (req, res) => {
  const lesson = await servicesMedia.getPublicMedia(req.params.id);
  const target = `${env.clientUrl}/l/${encodeURIComponent(req.params.id)}`;
  const title = lesson ? lesson.title : "שיעור בפלטפורמת הקהילה";
  const by = lesson?.creator_name && lesson.creator_name !== servicesMedia.DEFAULT_CREATOR ? ` · ${lesson.creator_name}` : "";
  const description = lesson ? excerpt(lesson.ai_summary || lesson.description || "") : "";
  const image = lesson?.thumbnail_url && /^https?:\/\//.test(lesson.thumbnail_url)
    ? lesson.thumbnail_url
    : `${env.clientUrl}/icons/icon-512.png`;
  const meta = [
    ["og:type", "article"],
    ["og:site_name", "פלטפורמת הקהילה"],
    ["og:title", `${title}${by}`],
    ["og:description", description],
    ["og:image", image],
    ["og:url", target],
    ["og:locale", "he_IL"],
  ].filter(([, v]) => v).map(([p, v]) => `<meta property="${p}" content="${escapeHtml(v)}">`).join("");
  res
    .status(200)
    .type("html")
    .set("Cache-Control", "public, max-age=300")
    .send(
      `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">` +
      `<title>${escapeHtml(`${title}${by}`)}</title>` +
      `<meta name="description" content="${escapeHtml(description)}">${meta}` +
      `<meta name="twitter:card" content="summary">` +
      `<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">` +
      `</head><body><a href="${escapeHtml(target)}">${escapeHtml(title)}</a></body></html>`
    );
};
