// @ts-check
// A calendar file for one live session (PRD NOTIF-3) — RFC 5545, by hand.
//
// One event, a handful of properties: a library would be a dependency for
// forty lines. The three rules that make a hand-written file fail in real
// calendars are each handled below and each has a test:
//
//   · TEXT values escape backslash, semicolon, comma and newlines (§3.3.11) —
//     a title with a comma otherwise loses everything after it in Outlook;
//   · lines are folded at 75 OCTETS, not characters (§3.1). A Hebrew letter is
//     two bytes in UTF-8, so folding by length produced lines of up to 150
//     bytes, and splitting inside a letter corrupts it;
//   · times are UTC with a trailing Z, so no VTIMEZONE block is needed and the
//     event lands at the right minute in every client's own zone.
//
// Lines end in CRLF, as the RFC requires.
import { env } from "./env.js";

// How long the event is drawn. A session has no planned end time — only
// a start — and an hour is what a shiur usually runs.
export const DEFAULT_DURATION_MINUTES = 60;

const escapeText = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

// 20261101T153000Z
const utcStamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Fold one logical line into physical lines of at most 75 octets, each
// continuation starting with a single space. Splits only between characters.
export const foldLine = (line) => {
  const out = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    // The first line may hold 75 octets; a continuation holds 74 plus its space.
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
};

/**
 * @param {{ id: number, title?: string | null, startsAt: Date, hostName?: string | null,
 *           url: string, domain: string, now?: Date }} session
 */
export const sessionCalendar = ({ id, title, startsAt, hostName, url, domain, now = new Date() }) => {
  const end = new Date(startsAt.getTime() + DEFAULT_DURATION_MINUTES * 60_000);
  const summary = title || "מפגש חי";
  const description = [hostName ? `מארח: ${hostName}` : null, url].filter(Boolean).join("\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//community-platform//sessions//HE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    // Stable per session, so importing the file twice updates one event rather
    // than creating two.
    `UID:session-${id}@${domain}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(startsAt)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .map(foldLine)
    .join("\r\n") + "\r\n";
};

// A session row as the notifications service and the download route read it
// (`starts_at` already converted to a real instant in SQL — see
// servicesSessions.getSessionSchedule), with this deployment's links.
/** @param {{ id: number, title?: string | null, host_name?: string | null, starts_at: Date | string }} session */
export const calendarForSession = (session) =>
  sessionCalendar({
    id: session.id,
    title: session.title,
    hostName: session.host_name,
    startsAt: new Date(session.starts_at),
    url: `${env.clientUrl}/sessions`,
    domain: new URL(env.clientUrl).hostname,
  });
