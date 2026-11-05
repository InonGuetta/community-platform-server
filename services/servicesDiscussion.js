// @ts-check
// The discussion service — the "דיון עם AI" tab on a lesson page. One resource,
// a folder of concerns, one entry point, the same arrangement as
// servicesTranscripts.js and for the same reason: the controller imports this
// file and never needs to know how the folder is cut.
//
//   discussion/access.js         may the caller discuss this lesson at all —
//                                asked first by every door below
//   discussion/retrieval.js      search inside ONE lesson (keyword + exact
//                                vector, RRF, GPT-4o rerank) — the smart-search
//                                mode, and the retrieval the chat builds on
//   discussion/conversations.js  the conversation store (migration 032)
//   discussion/context.js        which of the lesson's text a question is sent
//                                with: the whole lesson when it fits, retrieved
//                                passages when it does not
//   discussion/chat.js           the grounded answer, its checked citations,
//                                and storing the exchange
//   discussion/archive.js        the same chat over every lesson the caller
//                                may see (PRD ASK-2)

export { searchWithinMedia } from "./discussion/retrieval.js";

export {
  getLatestConversation,
  startConversation,
  appendMessage,
  getRecentMessages,
  listConversations,
  getConversationById,
  resumeConversation,
  deleteConversation,
} from "./discussion/conversations.js";

export { askInLesson, prepareAsk, streamAsk, questionQuota } from "./discussion/chat.js";

// The same chat over the whole archive (PRD ASK-2): its retrieval, citations
// and conversation; the answer itself is streamAsk above.
//   discussion/archive.js
export { getArchiveConversation, startArchiveConversation, prepareArchiveAsk } from "./discussion/archive.js";
