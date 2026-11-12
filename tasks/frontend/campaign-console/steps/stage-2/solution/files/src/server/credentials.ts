// What a reconnect may change in a stored credential, per method. The body comes from a browser,
// so it is untrusted (README, rule 3): it is read field by field, in a fixed order, and the new
// credential is built only from the fields this method has. The platform rules are in
// docs/platforms/*.md, "Reconnecting".
import { ValidationError } from "./errors.ts";
import type { ApiKeyCredential, Connection, Credential, OAuthCredential, SessionCredential } from "../shared/types.ts";

type Body = Record<string, unknown>;

/** The fields each method's body is checked for, in the order errors are reported. */
export const RECONNECT_FIELDS = {
  oauth: ["accessToken", "refreshToken", "expiresIn"],
  api_key: ["accountSid", "apiKeySid", "apiKeySecret"],
  session: ["cookies", "cookies.lf_session", "cookies.lf_csrf", "userAgent"],
} as const;

function isObject(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(body: Body, key: string, field = key): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new ValidationError(`${field} must be a non-empty string`, field);
  return value;
}

/**
 * Google re-issues a refresh token only when the user goes through consent again; Meta has none at
 * all (docs/platforms/google.md, meta.md). So a refresh token in the body replaces the stored one
 * on Google, its absence keeps the stored one, and Meta never stores one.
 */
function oauth(connection: Connection, stored: OAuthCredential, body: Body, now: number): OAuthCredential {
  const accessToken = requireString(body, "accessToken");
  const sent = body.refreshToken;
  if (sent !== undefined && (typeof sent !== "string" || sent.length === 0)) {
    throw new ValidationError("refreshToken, when present, must be a non-empty string", "refreshToken");
  }
  const { expiresIn } = body;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ValidationError("expiresIn must be a positive number of seconds", "expiresIn");
  }
  const credential: OAuthCredential = {
    method: "oauth",
    accessToken,
    // expires_in is seconds; every clock in the console is a ms epoch.
    expiresAt: now + Math.round(expiresIn * 1000),
    scope: stored.scope,
  };
  if (connection.platform !== "meta") {
    const refreshToken = sent ?? stored.refreshToken;
    if (refreshToken !== undefined) credential.refreshToken = refreshToken;
  }
  return credential;
}

/** A new key pair is what rotating means; the account is the connection (docs/platforms/twilio.md). */
function apiKey(stored: ApiKeyCredential, body: Body): ApiKeyCredential {
  const accountSid = requireString(body, "accountSid");
  if (accountSid !== stored.accountSid) {
    throw new ValidationError("accountSid must be this connection's account: a different account is a new connection", "accountSid");
  }
  return {
    method: "api_key",
    accountSid: stored.accountSid,
    apiKeySid: requireString(body, "apiKeySid"),
    apiKeySecret: requireString(body, "apiKeySecret"),
  };
}

/** A new login gives new cookies and that browser's user agent; the profile stays (docs/platforms/linkfolio.md). */
function session(stored: SessionCredential, body: Body): SessionCredential {
  const { cookies } = body;
  if (!isObject(cookies)) throw new ValidationError("cookies must be an object with lf_session and lf_csrf", "cookies");
  const lf_session = requireString(cookies, "lf_session", "cookies.lf_session");
  const lf_csrf = requireString(cookies, "lf_csrf", "cookies.lf_csrf");
  return { method: "session", cookies: { lf_session, lf_csrf }, userAgent: requireString(body, "userAgent"), profileUrl: stored.profileUrl };
}

/**
 * The credential to store for a reconnect of `connection` with `body`. Throws ValidationError
 * naming the first field (RECONNECT_FIELDS order) that is missing, of the wrong type or not
 * allowed. Fields the method doesn't have are ignored.
 */
export function credentialFromReconnect(connection: Connection, body: unknown, now: number): Credential {
  const fields: Body = isObject(body) ? body : {};
  const stored = connection.credential;
  switch (stored.method) {
    case "oauth":
      return oauth(connection, stored, fields, now);
    case "api_key":
      return apiKey(stored, fields);
    case "session":
      return session(stored, fields);
  }
}
