// @ts-check
// The socket protocol, named once.
//
// Every one of these strings exists twice — once where the server listens or
// emits, once where the client does. A typo in either copy does not raise an
// error anywhere: socket.io simply registers a listener nothing will ever fire,
// or emits an event nothing is listening for. The symptom is a video room that
// silently never connects, with no stack trace to follow.
//
// The client keeps a mirror of this file at src/utilities/socketEvents.js. Both
// sides must be edited together — which is the point: an event added on one side
// only is now visible as a file that was not changed.
export const SOCKET_EVENTS = {
  // Client → server
  JOIN_ROOM: "join-room",
  LEAVE_ROOM: "leave-room",
  END_SESSION: "end-session",

  // Server → client
  USER_JOINED: "user-joined",
  USER_LEFT: "user-left",
  SESSION_ENDED: "session-ended",
  JOIN_ERROR: "join-error",
  SESSION_ERROR: "session-error",

  // WebRTC signalling, relayed in both directions
  OFFER: "offer",
  ANSWER: "answer",
  ICE_CANDIDATE: "ice-candidate",
};

// Built-in socket.io lifecycle events, listed so call sites can use the same
// vocabulary as the application events above rather than mixing bare strings in.
export const SOCKET_LIFECYCLE = {
  CONNECTION: "connection",
  CONNECT: "connect",
  DISCONNECT: "disconnect",
  DISCONNECTING: "disconnecting",
};
