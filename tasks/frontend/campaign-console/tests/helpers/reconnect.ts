// Reconnect helpers for the stage 2 tests: the credentials a user brings, posting them, and fake
// platforms that accept only some tokens (and revoke the old one partway through a run).
//
//   const sends = acceptOnly(s.fakes.twilio, [SECRETS.twilioApiKeySecret], { revokeAfter: 2 });
//   await runUntilSettled(s.server.runner.start("run_t"), s.scheduler);   // pauses at item 3
//   sends.allow(NEW.twilioApiKeySecret);
//   const r = await postCredentials(s.url, "conn_twilio", twilioBody());   // { status, body, text }
//   await until(() => s.store.getRun("run_t").status === "completed", s.scheduler);
import { PUBLIC } from "./seed.ts";
import type { FakeAdapter } from "./fake-platforms.ts";
import type { FakeScheduler } from "./fake-scheduler.ts";

/** New credentials, as the user pastes them on a reconnect. Long alphanumeric, like the seed's. */
export const NEW = {
  googleAccessToken: "fakegNA5tY8uI1oP4aS7dF0gH3jK6lZ9xC2vB5nM8qW1eR4tY7uI",
  googleRefreshToken: "fakegNR2wE5rT8yU1iO4pA7sD0fG3hJ6kL9zX2cV5bN8mQ1wE4rT",
  metaAccessToken: "fakemNA8kL1zX4cV7bN0mQ3wE6rT9yU2iO5pA8sD1fG4hJ7kL0zX",
  metaRefreshToken: "fakemNR4hJ7kL0zX3cV6bN9mQ2wE5rT8yU1iO4pA7sD0fG3hJ6kL",
  twilioApiKeySid: "SK00112233445566778899aabbccddeeff",
  twilioApiKeySecret: "faketNS6yU9iO2pA5sD8fG1hJ4kL7zX0cV3bN6mQ9wE2rT5yU8iO",
  linkedinLiAt: "fakelNA3eR6tY9uI2oP5aS8dF1gH4jK7lZ0xC3vB6nM9qW2eR5tY",
  linkedinJsessionId: "fakelNJ7bN0mQ3wE6rT9yU2iO5pA8sD1fG4hJ7kL0zX3cV6bN9mQ",
  linkedinUserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
} as const;

/** The new secrets, plus Twilio's basic auth of the new key (what a leaked authorization header carries). */
export const NEW_SECRETS: string[] = [
  NEW.googleAccessToken,
  NEW.googleRefreshToken,
  NEW.metaAccessToken,
  NEW.metaRefreshToken,
  NEW.twilioApiKeySecret,
  NEW.linkedinLiAt,
  NEW.linkedinJsessionId,
  Buffer.from(`${NEW.twilioApiKeySid}:${NEW.twilioApiKeySecret}`).toString("base64"),
];

export const twilioBody = (overrides: Record<string, unknown> = {}) => ({
  accountSid: PUBLIC.twilioAccountSid,
  apiKeySid: NEW.twilioApiKeySid,
  apiKeySecret: NEW.twilioApiKeySecret,
  ...overrides,
});

export const linkedinBody = (overrides: Record<string, unknown> = {}) => ({
  cookies: { li_at: NEW.linkedinLiAt, JSESSIONID: NEW.linkedinJsessionId },
  userAgent: NEW.linkedinUserAgent,
  ...overrides,
});

export interface Posted {
  status: number;
  /** The parsed JSON answer (undefined when it isn't JSON). */
  body: any;
  text: string;
}

/** POST /api/connections/:id/credentials. A string body is sent as is (for malformed JSON). */
export async function postCredentials(url: string, connectionId: string, body: unknown): Promise<Posted> {
  const response = await fetch(`${url}/api/connections/${encodeURIComponent(connectionId)}/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}

export interface Sends {
  /** Ids of the items the platform accepted, in order. */
  accepted: string[];
  /** Tokens the platform accepts right now (probes and sends). */
  valid: Set<string>;
  allow(token: string): void;
}

/**
 * The fake accepts probes and sends only with these tokens (its tokenOf: accessToken, apiKeySecret
 * or li_at); anything else is rejected as unauthorized, shaped like the real adapters' errors.
 * With revokeAfter, the original tokens stop working right after that many accepted sends (the
 * customer deleted the key mid-campaign).
 */
export function acceptOnly(fake: FakeAdapter, tokens: string[], options: { revokeAfter?: number } = {}): Sends {
  const valid = new Set(tokens);
  fake.validTokens = valid;
  const accepted: string[] = [];
  fake.always("send", (_credential: any, item: any) => {
    accepted.push(item.id);
    if (options.revokeAfter !== undefined && accepted.length === options.revokeAfter) for (const t of tokens) valid.delete(t);
    return Promise.resolve({ externalId: `${fake.platform}-${item.id}` });
  });
  return { accepted, valid, allow: (token) => valid.add(token) };
}

/**
 * Lets the app work (fake clock stepping by `stepMs`, a macrotask between steps) until `predicate`
 * holds; fails after `deadlineMs` of real time. For background work such as a resumed run.
 */
export async function until(predicate: () => boolean, scheduler: FakeScheduler, { stepMs = 1_000, deadlineMs = 2_000, what = "condition" } = {}): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what} not reached within ${deadlineMs} ms`);
    await scheduler.advance(stepMs);
  }
}

/** Resolves with `promise`'s value, or rejects if it hasn't settled within `ms` of real time. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
