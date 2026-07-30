// Who may see unpublished material and manage the library.
//
// Kept here rather than beside one controller because media AND transcripts
// have to agree on it: a transcript inherits the visibility of its media item,
// so a second copy of this rule drifting out of sync is precisely how a draft
// leaks through the search or the transcript endpoint.
export const isPrivileged = (user) => user?.role === "lecturer" || user?.role === "admin";
