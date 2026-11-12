// @ts-check

// Text placed inside HTML the server writes itself — an element's body or an
// attribute's value — so that what somebody else typed (a lesson title, a
// display name) arrives as text and never as markup. Both quote kinds are
// escaped, so the result is safe inside a double- or a single-quoted attribute.
//
// Used by the notification mails (lib/mailer.js) and the link-preview page a
// shared lesson answers with.
export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
