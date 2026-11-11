import { createGoogleAdapter } from "./google.ts";
import { createLinkedInAdapter } from "./linkedin.ts";
import { createMetaAdapter } from "./meta.ts";
import { createSandboxPlatforms } from "./sandbox.ts";
import { createTwilioAdapter } from "./twilio.ts";
import type { PlatformRegistry } from "./types.ts";

export type { PlatformAdapter, PlatformRegistry } from "./types.ts";
export { createGoogleAdapter, createLinkedInAdapter, createMetaAdapter, createSandboxPlatforms, createTwilioAdapter };

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set (needed with RELAY_PLATFORMS=live)`);
  return value;
}

/** The real integrations. Base URLs can be overridden to point at a recording proxy. */
export function createLivePlatforms(env: Env, now: () => number = Date.now): PlatformRegistry {
  return {
    google: createGoogleAdapter({
      apiBaseUrl: env.GOOGLE_ADS_BASE_URL ?? "https://googleads.googleapis.com",
      oauthBaseUrl: env.GOOGLE_OAUTH_BASE_URL ?? "https://oauth2.googleapis.com",
      developerToken: required(env, "GOOGLE_ADS_DEVELOPER_TOKEN"),
      clientId: required(env, "GOOGLE_CLIENT_ID"),
      clientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
      now,
    }),
    meta: createMetaAdapter({
      graphBaseUrl: env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com",
      appId: required(env, "META_APP_ID"),
      appSecret: required(env, "META_APP_SECRET"),
      now,
    }),
    twilio: createTwilioAdapter({
      apiBaseUrl: env.TWILIO_BASE_URL ?? "https://api.twilio.com",
      messagingServiceSid: required(env, "TWILIO_MESSAGING_SERVICE_SID"),
    }),
    linkedin: createLinkedInAdapter({ baseUrl: env.LINKEDIN_BASE_URL ?? "https://www.linkedin.com" }),
  };
}

/** "80,600" -> [80, 600]; undefined when unset or malformed. */
function parseRange(value: string | undefined): [number, number] | undefined {
  const parts = value?.split(",").map(Number);
  if (!parts || parts.length !== 2 || !parts.every((n) => Number.isFinite(n) && n >= 0) || parts[0] > parts[1]) return undefined;
  return [parts[0], parts[1]];
}

function parseRate(value: string | undefined): number | undefined {
  const rate = value === undefined || value === "" ? NaN : Number(value);
  return rate >= 0 && rate <= 1 ? rate : undefined;
}

/**
 * RELAY_PLATFORMS=live uses the real integrations; anything else the sandbox, tuned with
 * RELAY_SANDBOX_LATENCY_MS ("min,max") and RELAY_SANDBOX_FAILURE_RATE (0..1).
 */
export function platformsFromEnv(env: Env, now: () => number = Date.now): PlatformRegistry {
  if (env.RELAY_PLATFORMS === "live") return createLivePlatforms(env, now);
  return createSandboxPlatforms({
    now,
    latencyMs: parseRange(env.RELAY_SANDBOX_LATENCY_MS),
    failureRate: parseRate(env.RELAY_SANDBOX_FAILURE_RATE),
  });
}
