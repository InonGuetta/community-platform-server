// Types only — nothing here is imported at runtime and nothing is compiled.
//
// The socket authentication middleware verifies the JWT from the handshake
// cookie and attaches the result to the socket, which every handler then reads
// as the caller's verified identity. socket.io has no notion of that property,
// so type checking reported each use as a mistake.
//
// Declared as an augmentation rather than worked around with a cast at each of
// the seven call sites: the property really is present on every socket that
// reaches a handler (the middleware rejects the connection otherwise), so this
// describes the application's actual contract instead of silencing a symptom.
//
// Optional on purpose. It is genuinely absent for the moment between the socket
// connecting and the middleware running, and marking it required would let a
// future handler read it in that window with the checker's blessing.
import "socket.io";

declare module "socket.io" {
  interface Socket {
    user?: {
      id: number;
      role: string;
    };
  }
}
