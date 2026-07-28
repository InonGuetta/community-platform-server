// Several modules read process.env at import time (the pg pool, the Stripe and
// OpenAI clients). None of them connect eagerly, so placeholder values are
// enough to import the code under test — and using placeholders rather than the
// real .env guarantees a test run can never touch live infrastructure.
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:1";
process.env.JWT_SECRET ||= "test-secret";
process.env.OPENAI_API_KEY ||= "sk-test";
process.env.STRIPE_SECRET_KEY ||= "sk_test_placeholder";
process.env.GOOGLE_CLIENT_ID ||= "test-client-id";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";

// Replaces pool.query for one test and restores it afterwards. The pool is a
// shared object, so this has to be undone or the next test inherits the stub.
export const stubPoolQuery = (pool, impl) => {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    return impl(text, params) ?? { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
};

// Same idea for the transactional paths, which take a client out of the pool.
export const stubPoolConnect = (pool, impl) => {
  const original = pool.connect;
  const calls = [];
  pool.connect = async () => ({
    query: async (text, params) => {
      calls.push({ text, params });
      return impl(text, params) ?? { rows: [] };
    },
    release: () => {},
  });
  return { calls, restore: () => { pool.connect = original; } };
};
