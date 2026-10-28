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

export { searchWithinMedia } from "./discussion/retrieval.js";

export {
  getLatestConversation,
  startConversation,
  appendMessage,
  getRecentMessages,
  listConversations,
  getConversationById,
  resumeConversation,
} from "./discussion/conversations.js";

export { askInLesson, prepareAsk, streamAsk } from "./discussion/chat.js";
