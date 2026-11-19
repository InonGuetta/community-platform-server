import "./setup.js";
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "crypto";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { oauthLogin } from "../services/servicesAuth.js";
import { env } from "../lib/env.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Signing in with Apple and with LinkedIn: the round trip each makes through the
// browser (lib/oauthProviders.js, controllersAuth.oauthStart/oauthCallback), and
// the one rule that matters most once the provider has answered — that an
// identity only links to an existing account on an address the provider has
// verified. Neither provider is ever called: fetch is replaced per test.

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const { privateKey: applePrivateKey, publicKey: applePublicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const PROVIDER_ENV = {
  APPLE_CLIENT_ID: "org.example.web",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  // As it arrives from a one-line .env value: newlines written as \n.
  APPLE_PRIVATE_KEY: applePrivateKey.replace(/\n/g, "\\n"),
  LINKEDIN_CLIENT_ID: "li-client",
  LINKEDIN_CLIENT_SECRET: "li-secret",
};
const configure = (on) => {
  for (const [name, value] of Object.entries(PROVIDER_ENV)) {
    if (on) process.env[name] = value;
    else delete process.env[name];
  }
};

const realFetch = globalThis.fetch;
// Answers each provider URL from `routes`, records every call, and fails the
// test loudly on a URL nobody expected.
const stubFetch = (routes) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const match = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    if (!match) throw new Error(`unexpected fetch: ${url}`);
    const body = match[1];
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
};

afterEach(() => {
  globalThis.fetch = realFetch;
  configure(false);
});

const NEW_USER = { id: 9, email: "new@example.com", role: "student", display_name: "x", avatar_url: null };
// No account yet: the SELECT finds nothing, the INSERT returns the new row.
const freshDatabase = () =>
  stubPoolQuery(pool, (text) => (/INSERT INTO users/.test(text) ? { rows: [NEW_USER] } : { rows: [] }));

const setCookies = (res) => [].concat(res.headers["set-cookie"] ?? []);
const sessionCookie = (res) => setCookies(res).find((c) => /^token=[^;]+/.test(c));

// ── Not set up yet ──────────────────────────────────────────────────────────

for (const provider of ["apple", "linkedin"]) {
  test(`an unconfigured ${provider} sends the browser back with "not set up", not to the provider`, async () => {
    configure(false);
    const res = await request(app).get(`/api/auth/${provider}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `${env.clientUrl}/sign-in?error=${provider}_unavailable`);
  });
}

// ── LinkedIn ────────────────────────────────────────────────────────────────

test("LinkedIn: the start sends the browser to LinkedIn with a state this browser holds", async () => {
  configure(true);
  const res = await request(app).get("/api/auth/linkedin");
  assert.equal(res.status, 302);
  const to = new URL(res.headers.location);
  assert.equal(to.origin + to.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(to.searchParams.get("client_id"), "li-client");
  assert.equal(to.searchParams.get("scope"), "openid profile email");
  assert.match(to.searchParams.get("redirect_uri"), /\/api\/auth\/linkedin\/callback$/);

  const cookie = setCookies(res).find((c) => c.startsWith("oauth_linkedin="));
  assert.ok(cookie, "the challenge cookie must be set");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/api\/auth\/linkedin\/callback/);
  assert.equal(cookie.split(";")[0].split("=")[1].split(".")[0], to.searchParams.get("state"));
});

test("LinkedIn: a state that is not this browser's is refused before LinkedIn is asked anything", async () => {
  configure(true);
  const calls = stubFetch({});
  const res = await request(app)
    .get("/api/auth/linkedin/callback?code=abc&state=attacker")
    .set("Cookie", "oauth_linkedin=mine.nonce");
  assert.equal(res.headers.location, `${env.clientUrl}/sign-in?error=linkedin_failed`);
  assert.equal(calls.length, 0);
  assert.equal(sessionCookie(res), undefined);
});

test("LinkedIn: a callback with no challenge cookie at all is refused", async () => {
  configure(true);
  const calls = stubFetch({});
  const res = await request(app).get("/api/auth/linkedin/callback?code=abc&state=");
  assert.equal(res.headers.location, `${env.clientUrl}/sign-in?error=linkedin_failed`);
  assert.equal(calls.length, 0);
});

test("LinkedIn: the user pressing cancel goes back to sign-in", async () => {
  configure(true);
  const res = await request(app)
    .get("/api/auth/linkedin/callback?error=user_cancelled_login&state=s")
    .set("Cookie", "oauth_linkedin=s.n");
  assert.equal(res.headers.location, `${env.clientUrl}/sign-in?error=linkedin_failed`);
});

test("LinkedIn: a full return signs the user in under linkedin_id", async () => {
  configure(true);
  const calls = stubFetch({
    "https://www.linkedin.com/oauth/v2/accessToken": { access_token: "at-1" },
    "https://api.linkedin.com/v2/userinfo": {
      sub: "li-777", email: "New@Example.com", email_verified: true, name: "משה כהן",
      picture: "https://media.licdn.com/a.jpg",
    },
  });
  const db = freshDatabase();
  try {
    const res = await request(app)
      .get("/api/auth/linkedin/callback?code=the-code&state=s1")
      .set("Cookie", "oauth_linkedin=s1.n1");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `${env.clientUrl}/auth/callback`);
    assert.ok(sessionCookie(res), "a session cookie must be set");

    const tokenBody = new URLSearchParams(calls[0].init.body);
    assert.equal(tokenBody.get("code"), "the-code");
    assert.equal(tokenBody.get("client_secret"), "li-secret");
    assert.match(tokenBody.get("redirect_uri"), /\/api\/auth\/linkedin\/callback$/);
    assert.equal(calls[1].init.headers.Authorization, "Bearer at-1");

    const insert = db.calls.find((c) => /INSERT INTO users/.test(c.text));
    assert.match(insert.text, /linkedin_id/);
    assert.deepEqual(insert.params, ["new@example.com", "li-777", "משה כהן", "https://media.licdn.com/a.jpg"]);
  } finally {
    db.restore();
  }
});

// ── Apple ───────────────────────────────────────────────────────────────────

test("Apple: the start asks for a form_post return, with a nonce, and a cookie Apple's POST will carry", async () => {
  configure(true);
  const res = await request(app).get("/api/auth/apple");
  const to = new URL(res.headers.location);
  assert.equal(to.origin + to.pathname, "https://appleid.apple.com/auth/authorize");
  assert.equal(to.searchParams.get("response_mode"), "form_post");
  assert.equal(to.searchParams.get("scope"), "name email");
  assert.ok(to.searchParams.get("nonce"));

  const cookie = setCookies(res).find((c) => c.startsWith("oauth_apple="));
  // A cross-site POST carries no SameSite=Lax cookie; without None the state
  // check would refuse every single Apple sign-in.
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);
  const [state, nonce] = cookie.split(";")[0].split("=")[1].split(".");
  assert.equal(state, to.searchParams.get("state"));
  assert.equal(nonce, to.searchParams.get("nonce"));
});

const appleIdToken = (over = {}) =>
  jwt.sign(
    {
      iss: "https://appleid.apple.com",
      aud: "org.example.web",
      sub: "apple-001",
      email: "new@example.com",
      email_verified: "true",
      nonce: "n1",
      ...over,
    },
    "irrelevant",
    { expiresIn: "5m" }
  );

const postAppleCallback = (fields, cookie = "oauth_apple=s1.n1") =>
  request(app).post("/api/auth/apple/callback").type("form").set("Cookie", cookie).send(fields);

test("Apple: a full return signs the user in under apple_id, with the name Apple sends only once", async () => {
  configure(true);
  const calls = stubFetch({ "https://appleid.apple.com/auth/token": { id_token: appleIdToken() } });
  const db = freshDatabase();
  try {
    const res = await postAppleCallback({
      code: "c1",
      state: "s1",
      user: JSON.stringify({ name: { firstName: "Moshe", lastName: "Cohen" } }),
    });
    assert.equal(res.headers.location, `${env.clientUrl}/auth/callback`);
    assert.ok(sessionCookie(res));

    // The client secret is a JWT signed with the .p8 key, naming our team and
    // Services ID — the \n-escaped key had to be put back together to sign it.
    const secret = new URLSearchParams(calls[0].init.body).get("client_secret");
    const claims = jwt.verify(secret, applePublicKey, { algorithms: ["ES256"] });
    assert.equal(claims.iss, "TEAM123456");
    assert.equal(claims.sub, "org.example.web");
    assert.equal(claims.aud, "https://appleid.apple.com");
    assert.equal(jwt.decode(secret, { complete: true }).header.kid, "KEY1234567");

    const insert = db.calls.find((c) => /INSERT INTO users/.test(c.text));
    assert.match(insert.text, /apple_id/);
    assert.deepEqual(insert.params, ["new@example.com", "apple-001", "Moshe Cohen", null]);
  } finally {
    db.restore();
  }
});

test("Apple: an id_token carrying another nonce is refused, and nobody is created", async () => {
  configure(true);
  stubFetch({ "https://appleid.apple.com/auth/token": { id_token: appleIdToken({ nonce: "someone-else" }) } });
  const db = freshDatabase();
  try {
    const res = await postAppleCallback({ code: "c1", state: "s1" });
    assert.equal(res.headers.location, `${env.clientUrl}/sign-in?error=apple_failed`);
    assert.equal(sessionCookie(res), undefined);
    assert.equal(db.calls.length, 0);
  } finally {
    db.restore();
  }
});

test("Apple: an id_token minted for another app is refused", async () => {
  configure(true);
  stubFetch({ "https://appleid.apple.com/auth/token": { id_token: appleIdToken({ aud: "com.other.app" }) } });
  const db = freshDatabase();
  try {
    const res = await postAppleCallback({ code: "c1", state: "s1" });
    assert.equal(res.headers.location, `${env.clientUrl}/sign-in?error=apple_failed`);
    assert.equal(db.calls.length, 0);
  } finally {
    db.restore();
  }
});

test("Apple: a deactivated account goes back to sign-in, not to a JSON error", async () => {
  configure(true);
  stubFetch({ "https://appleid.apple.com/auth/token": { id_token: appleIdToken() } });
  const db = stubPoolQuery(pool, () => ({
    rows: [{ id: 4, email: "new@example.com", apple_id: "apple-001", is_active: false }],
  }));
  try {
    const res = await postAppleCallback({ code: "c1", state: "s1" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `${env.clientUrl}/sign-in?error=apple_failed`);
    assert.equal(sessionCookie(res), undefined);
  } finally {
    db.restore();
  }
});

// ── Linking, for every provider alike ───────────────────────────────────────

const passwordAccount = () => ({
  id: 4, email: "a@example.com", role: "student", password_hash: "$2a$12$hash",
  google_id: null, apple_id: null, linkedin_id: null, is_active: true, email_verified: true,
});

for (const provider of ["apple", "linkedin"]) {
  test(`${provider}: an unverified address cannot be linked to an existing account`, async () => {
    const db = stubPoolQuery(pool, () => ({ rows: [passwordAccount()] }));
    try {
      await assert.rejects(
        () => oauthLogin(provider, { id: "x-1", email: "a@example.com", emailVerified: false }),
        { statusCode: 401 }
      );
      assert.equal(db.calls.some((c) => /UPDATE users/.test(c.text)), false);
    } finally {
      db.restore();
    }
  });

  test(`${provider}: a verified address links to the existing account, in its own column`, async () => {
    const db = stubPoolQuery(pool, () => ({ rows: [passwordAccount()] }));
    try {
      const user = await oauthLogin(provider, { id: "x-1", email: "a@example.com", emailVerified: true });
      assert.equal(user.id, 4);
      assert.equal(user.password_hash, undefined);
      const update = db.calls.find((c) => /UPDATE users SET/.test(c.text));
      assert.match(update.text, new RegExp(`SET\\s+${provider}_id = \\$1`));
    } finally {
      db.restore();
    }
  });
}

test("an unknown provider is a programming error, never spliced into SQL", async () => {
  const db = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await assert.rejects(() => oauthLogin("github; DROP TABLE users", { id: "1", email: "a@b.co", emailVerified: true }));
    assert.equal(db.calls.length, 0);
  } finally {
    db.restore();
  }
});
