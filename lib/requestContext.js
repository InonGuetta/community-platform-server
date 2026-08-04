// @ts-check
// Carries the current request's id through the whole async call stack, so a log
// line written deep inside a service can be tied back to the HTTP request that
// caused it — without threading a `requestId` argument through every function.
//
// AsyncLocalStorage is the only mechanism that survives `await`: a plain module
// variable would be overwritten by the next concurrent request the moment the
// current one yields, and would silently attribute log lines to the wrong user.
//
// Deliberately dependency-free and never throws when there is no active request:
// the queue workers, the migration scripts and the tests all import the logger
// without ever entering a request, and they must keep working unchanged.
import { AsyncLocalStorage } from "async_hooks";

const storage = new AsyncLocalStorage();

// Everything registered for this request runs inside `fn`, including whatever it
// awaits. Returning the callback's value keeps this transparent to Express.
export const runWithRequestId = (requestId, fn) => storage.run({ requestId }, fn);

// undefined outside a request — the logger treats that as "no prefix".
export const getRequestId = () => storage.getStore()?.requestId;
