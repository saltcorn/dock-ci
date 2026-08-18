import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkCredentials,
  createSession,
  DEFAULT_ADMIN_USERNAME,
  parseBasicAuth,
  parseCookies,
  readSession,
  SESSION_COOKIE,
  sessionCookieHeader,
  sessionKey,
} from "../lib/auth.ts";

/** An `Authorization: Basic` header value for the given credentials. */
function basic(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

test("the default admin username is admin", () => {
  assert.equal(DEFAULT_ADMIN_USERNAME, "admin");
});

test("parseBasicAuth decodes a Basic header, keeping colons in the password", () => {
  assert.deepEqual(parseBasicAuth(basic("admin", "s3cret")), {
    username: "admin",
    password: "s3cret",
  });
  // Only the first colon separates the two fields.
  assert.deepEqual(parseBasicAuth(basic("admin", "a:b:c")), {
    username: "admin",
    password: "a:b:c",
  });
  // The scheme is matched case-insensitively, as HTTP requires.
  assert.deepEqual(parseBasicAuth("basic " + Buffer.from("u:p").toString("base64")), {
    username: "u",
    password: "p",
  });
});

test("parseBasicAuth rejects a missing, non-Basic or malformed header", () => {
  assert.equal(parseBasicAuth(undefined), undefined);
  assert.equal(parseBasicAuth("Bearer token"), undefined);
  assert.equal(parseBasicAuth("Basic"), undefined);
  // Decodes, but carries no colon, so there is no username/password split.
  assert.equal(
    parseBasicAuth("Basic " + Buffer.from("nocolon").toString("base64")),
    undefined,
  );
});

test("credentials match only when both halves are right", () => {
  const auth = { username: "admin", password: "hunter2" };
  assert.equal(checkCredentials(auth, { username: "admin", password: "hunter2" }), true);
  assert.equal(checkCredentials(auth, { username: "admin", password: "wrong" }), false);
  assert.equal(checkCredentials(auth, { username: "root", password: "hunter2" }), false);
  assert.equal(checkCredentials(auth, undefined), false);
});

test("with no password configured every login attempt fails", () => {
  // The documented behaviour of an unset ADMIN_PASSWORD: nothing authenticates,
  // and in particular an empty password does not.
  for (const auth of [{ username: "admin" }, { username: "admin", password: "" }]) {
    assert.equal(checkCredentials(auth, { username: "admin", password: "" }), false);
    assert.equal(checkCredentials(auth, { username: "admin", password: "x" }), false);
    assert.equal(checkCredentials(auth, undefined), false);
  }
});

test("a session round-trips through its encrypted cookie", () => {
  const key = sessionKey("hunter2");
  const cookie = createSession(key, "admin", Date.now() + 60_000);
  assert.equal(readSession(key, cookie), "admin");
  // The username is encrypted, not merely encoded.
  assert.doesNotMatch(cookie, /admin/);
});

test("an expired, tampered, foreign or malformed session is not accepted", () => {
  const key = sessionKey("hunter2");
  const now = Date.now();

  assert.equal(readSession(key, createSession(key, "admin", now - 1), now), undefined);

  // Flipping any byte of the ciphertext fails the authentication tag.
  const cookie = createSession(key, "admin", now + 60_000);
  const parts = cookie.split(".");
  const body = Buffer.from(parts[3]!, "base64url");
  body.writeUInt8(body.readUInt8(0) ^ 0xff, 0);
  parts[3] = body.toString("base64url");
  assert.equal(readSession(key, parts.join("."), now), undefined);

  // A cookie issued under a different password (i.e. a different key).
  assert.equal(
    readSession(key, createSession(sessionKey("other"), "admin", now + 60_000), now),
    undefined,
  );

  assert.equal(readSession(key, undefined), undefined);
  assert.equal(readSession(key, "garbage"), undefined);
  assert.equal(readSession(key, "v2.a.b.c"), undefined);
});

test("the session cookie is HttpOnly, SameSite=Strict and Secure only on HTTPS", () => {
  const header = sessionCookieHeader("value", { maxAgeSeconds: 60, secure: false });
  assert.match(header, new RegExp(`^${SESSION_COOKIE}=value;`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=60/);
  assert.doesNotMatch(header, /Secure/);
  assert.match(
    sessionCookieHeader("value", { maxAgeSeconds: 60, secure: true }),
    /Secure/,
  );
});

test("parseCookies splits a Cookie header into its pairs", () => {
  const cookies = parseCookies("a=1; b=two; c=v1.x.y.z");
  assert.equal(cookies.get("a"), "1");
  assert.equal(cookies.get("b"), "two");
  // Values may contain the dots the session cookie uses as separators.
  assert.equal(cookies.get("c"), "v1.x.y.z");
  assert.equal(parseCookies(undefined).size, 0);
  assert.equal(parseCookies("novalue").size, 0);
});
