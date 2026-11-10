// @ts-check

// What a person typed is a phrase to find, not a pattern to match with.
//
// The value reaches ILIKE as a bound parameter, so this is not about injection —
// but ILIKE reads % and _ as wildcards wherever they appear, and they appear in
// real titles and names. Unescaped, a search for "100%" matches every title
// starting "100", and one for "פרק_ב" matches "פרקאב". Backslash is Postgres'
// default LIKE escape, and it has to escape itself first or a value containing
// one would consume the character after it.
//
// Every search that builds a LIKE pattern from user input goes through this:
// the archive, the notebook and the course roster.
export const escapeLike = (value) => String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
