import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * The account name accepted at `/login` when `ADMIN_USERNAME` is not set. There
 * is deliberately no matching password default: without `ADMIN_PASSWORD` the
 * login is disabled outright rather than falling back to a guessable one.
 */
export const DEFAULT_ADMIN_USERNAME = "admin";

/** Name of the cookie holding the encrypted session. */
export const SESSION_COOKIE = "whale_ci_session";

/** How long a session lasts before the user has to log in again. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** The single operator account the dashboard's write actions are gated on. */
export interface AuthConfig {
  /** Account name accepted at `/login`; defaults to {@link DEFAULT_ADMIN_USERNAME}. */
  username: string;
  /**
   * Password accepted at `/login`. Undefined when `ADMIN_PASSWORD` is unset, in
   * which case every login attempt fails and no session can ever exist.
   */
  password?: string;
}

/** Credentials decoded from an HTTP `Authorization: Basic` header. */
export interface BasicCredentials {
  username: string;
  password: string;
}

/**
 * Decode an `Authorization: Basic <base64>` header into its username and
 * password, or undefined when the header is absent, not Basic, or malformed.
 * Per RFC 7617 the decoded value is `user:pass`, and only the *first* colon
 * separates them — a password may contain colons of its own.
 */
export function parseBasicAuth(
  header: string | undefined,
): BasicCredentials | undefined {
  if (header === undefined) return undefined;
  const match = header.match(/^Basic\s+(\S+)$/i);
  if (match === null) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return undefined;
  return {
    username: decoded.slice(0, colon),
    password: decoded.slice(colon + 1),
  };
}

/**
 * Whether `credentials` match the configured account. Always false when no
 * password is configured, so an unset `ADMIN_PASSWORD` cannot be satisfied by
 * sending an empty one. Both fields are compared in constant time (over their
 * digests, so that differing lengths do not leak either).
 */
export function checkCredentials(
  auth: AuthConfig,
  credentials: BasicCredentials | undefined,
): boolean {
  if (auth.password === undefined || auth.password === "") return false;
  if (credentials === undefined) return false;
  // Both comparisons are always evaluated: `&&` would skip the second one as
  // soon as the username failed, leaking which half was wrong through timing.
  const user = constantTimeEqual(credentials.username, auth.username);
  const pass = constantTimeEqual(credentials.password, auth.password);
  return user && pass;
}

/** Compare two strings without an early exit on the first differing byte. */
function constantTimeEqual(a: string, b: string): boolean {
  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Derive the 32-byte key that session cookies are encrypted with from the
 * configured password. Deriving it (rather than taking a separate secret)
 * keeps the server's configuration to one variable and means changing the
 * password invalidates every session issued under the old one. The key is
 * stable across restarts, so a session survives a server restart.
 */
export function sessionKey(password: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", password, "whale-ci session salt v1", "session-cookie", 32),
  );
}

/** Associated data binding a cookie to this purpose, so it decrypts nowhere else. */
const AAD = Buffer.from("whale-ci-session-v1");

/**
 * Encrypt a session for `username` into a cookie value, valid until
 * `expiresAt`. The value is `v1.<iv>.<tag>.<ciphertext>` in base64url:
 * AES-256-GCM, so the cookie is both unreadable and unforgeable by the client —
 * the expiry inside it cannot be extended by editing the cookie.
 */
export function createSession(
  key: Buffer,
  username: string,
  expiresAt: number,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const payload = JSON.stringify({ u: username, e: expiresAt });
  const body = Buffer.concat([
    cipher.update(payload, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a session cookie, returning the username it was issued to, or
 * undefined when it is malformed, was not issued by this key (a forgery, or a
 * session from before the password changed), or has expired.
 */
export function readSession(
  key: Buffer,
  value: string | undefined,
  now: number = Date.now(),
): string | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(parts[1]!, "base64url"),
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const session = JSON.parse(plain) as { u?: unknown; e?: unknown };
    if (typeof session.u !== "string" || typeof session.e !== "number") {
      return undefined;
    }
    // The expiry is inside the authenticated ciphertext, so this check cannot
    // be bypassed by a client editing its own cookie.
    if (session.e <= now) return undefined;
    return session.u;
  } catch {
    // Any tampering fails the GCM tag check and lands here, as does a cookie
    // encrypted under a previous password.
    return undefined;
  }
}

/**
 * Build the `Set-Cookie` header carrying `value`. `HttpOnly` keeps the session
 * out of reach of scripts, and `SameSite=Strict` is what defends the rerun
 * form against cross-site posts: a request originating anywhere but this
 * dashboard arrives without the cookie and is refused. `Secure` is added when
 * the dashboard is served over HTTPS.
 */
export function sessionCookieHeader(
  value: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Parse a request's `Cookie` header into name/value pairs. Values are returned
 * exactly as sent; the last occurrence of a repeated name wins.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name === "") continue;
    cookies.set(name, pair.slice(eq + 1).trim());
  }
  return cookies;
}
