// @ts-check
import { Pool } from "pg";
import { logger, debugEnabled } from "../lib/logger.js";

if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

// Certificate verification on the database connection, and why it is off by
// default.
//
// The connection IS encrypted either way; what rejectUnauthorized decides is
// whether the server's certificate is checked against a trusted CA. Supabase
// presents a chain Node does not trust out of the box, so verifying without
// supplying its root certificate fails every connection — which is why this was
// turned off, and then never written down. Left as a bare `false` it reads as a
// setting nobody chose, and an unverified certificate means a machine positioned
// between this process and the database can present its own and read every query,
// passwords and transcripts included.
//
// So it stays permissive by DEFAULT — flipping it here would break every existing
// deployment on the next restart, which is not a change to make on someone's
// behalf — but it is now one variable, stated in .env.example, rather than a
// decision buried in a constructor. To tighten it: download the provider's root
// certificate, point PGSSLROOTCERT at it (Node's TLS stack reads that), and set
// DATABASE_SSL_STRICT=true.
const sslStrict = process.env.DATABASE_SSL_STRICT === "true";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: sslStrict },
  keepAlive: true,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  query_timeout: 15000,
});

if (!sslStrict) {
  logger.warn(
    "[pg pool] TLS certificate verification is disabled (DATABASE_SSL_STRICT is not \"true\") — " +
    "the connection is encrypted but the server's identity is not checked"
  );
}

// A pool-level error (e.g. an idle client dropped by Supabase) will crash the
// process if nothing listens. Log and swallow — the next acquire opens a fresh
// connection.
pool.on("error", (err) => {
  logger.error("[pg pool] idle client error:", err.message);
});

// ── Query instrumentation ───────────────────────────────────────────────────
//
// Every query is timed and logged with the id of the request that issued it, so
// a slow endpoint can be attributed to the specific statement responsible
// instead of being guessed at.
//
// The SQL text is logged; the PARAMETERS ARE NOT, and that is not an oversight.
// They hold exactly what the logger's header forbids recording — the password
// hash on registration, the email on login, the full text of a search, the body
// of a saved transcript. The statement alone identifies which query ran, which
// is all this needs to be useful.
const SLOW_QUERY_MS = 500;

// One line, whatever the source formatting: these are written as multi-line
// template literals throughout services/, and a raw dump would spread a single
// query over a dozen log lines.
const summarise = (text) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
};

const rowCount = (result) =>
  result?.rowCount ?? (Array.isArray(result?.rows) ? result.rows.length : 0);

// Wrapping by reassignment rather than by subclassing Pool is deliberate: it is
// what keeps test/setup.js working. Those helpers swap pool.query for a stub and
// restore it afterwards, so the stub simply replaces this wrapper for the
// duration of a test and the restore puts it back.
// pg's query() accepts a callback as well as returning a promise, and it uses
// the callback form INTERNALLY — Pool.query() checks out a client and calls
// `client.query(text, values, cb)`. A wrapper that only understands the promise
// form drops that callback, and the query then never completes: no error, no
// timeout, just a request that hangs until the browser gives up. That is not
// theoretical, it is the bug this shape exists to prevent.
//
// So: anything with a callback goes straight through untouched. Only the
// promise form — which is what every call in this application uses — is timed.
// Exported for test/poolInstrumentation.test.js, which drives it over a fake pg
// to prove both call forms survive. Testing it through the real pool is not an
// option: the rest of the suite replaces pool.query wholesale, so the wrapper
// would never run.
export const instrument = (label, original) => (...args) => {
  if (args.some((arg) => typeof arg === "function")) return original(...args);
  return timed(label, original, args[0], args[1]);
};

const timed = async (label, original, text, params) => {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await original(text, params);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (ms >= SLOW_QUERY_MS) {
      logger.warn(`[${label}] slow ${ms.toFixed(1)}ms (${rowCount(result)} rows): ${summarise(text)}`);
    } else if (debugEnabled()) {
      logger.debug(`[${label}] ${ms.toFixed(1)}ms (${rowCount(result)} rows): ${summarise(text)}`);
    }
    return result;
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // The message only — a pg error can carry the offending values in its
    // `detail` field, which is the same PII the parameters were withheld for.
    logger.error(`[${label}] failed after ${ms.toFixed(1)}ms: ${err.message} — ${summarise(text)}`);
    throw err;
  }
};

pool.query = instrument("pg", pool.query.bind(pool));

// Transactions (servicesUsers, services/transcripts/chunks.js) take a client out
// of the pool and run their statements on it, so without this they would be the
// only SQL in the app that never appears in the log.
//
// The guard matters: pg RECYCLES clients, so the same object comes back on a
// later checkout. Wrapping unconditionally would wrap the wrapper, again on
// every checkout, until a transaction was buried under dozens of layers.
const INSTRUMENTED = Symbol("instrumented");

const instrumentClient = (client) => {
  if (!client[INSTRUMENTED]) {
    client[INSTRUMENTED] = true;
    client.query = instrument("pg:tx", client.query.bind(client));
  }
  return client;
};

const rawConnect = pool.connect.bind(pool);

// pool.connect has TWO call signatures and both have to keep working.
//
// This is not a hypothetical: pg's own Pool.query() checks out its client by
// calling `this.connect((err, client) => …)` — the callback form — and
// `this.connect` is this function. An earlier version of this wrapper accepted
// no arguments, so that callback was silently dropped and the promise
// Pool.query returns never settled. Every single query in the application hung
// forever, with no error and no timeout, because the query was never issued.
//
// The callback form is passed straight through and left uninstrumented on
// purpose. It is pg's internal path, whose statements are already timed by the
// pool.query wrapper above; instrumenting it as well would log each of those
// queries twice.
pool.connect = (callback) => {
  if (typeof callback === "function") return rawConnect(callback);
  return rawConnect().then(instrumentClient);
};
