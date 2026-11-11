// Simulated platforms for local development (`npm start` uses them unless RELAY_PLATFORMS=live).
// They behave like the real ones where it matters to the console: some latency, the odd timeout,
// access tokens that expire, refreshes that hand out a new token.
import { PlatformError } from "../errors.ts";
import type { Clock, PlatformAdapter, PlatformRegistry } from "./types.ts";
import type { Credential, OAuthCredential, Platform, RunItem } from "../../shared/types.ts";

export interface SandboxOptions {
  now: Clock;
  random?: () => number;
  /** Share of calls that time out. */
  failureRate?: number;
  latencyMs?: [min: number, max: number];
}

const TOKEN_LIFETIME_S = 3600;

export function createSandboxPlatforms(options: SandboxOptions): PlatformRegistry {
  const random = options.random ?? Math.random;
  const failureRate = options.failureRate ?? 0.03;
  const [minMs, maxMs] = options.latencyMs ?? [80, 600];
  let issued = 0;

  const latency = () => new Promise<void>((resolve) => setTimeout(resolve, minMs + random() * (maxMs - minMs)));

  function authorizationOf(credential: Credential): string {
    switch (credential.method) {
      case "oauth":
        return `Bearer ${credential.accessToken}`;
      case "api_key":
        return `Basic ${Buffer.from(`${credential.apiKeySid}:${credential.apiKeySecret}`).toString("base64")}`;
      case "session":
        return `li_at=${credential.cookies.li_at}; JSESSIONID="${credential.cookies.JSESSIONID}"`;
    }
  }

  async function call(platform: Platform, path: string, credential: Credential): Promise<void> {
    await latency();
    const request = { url: `https://sandbox.${platform}.relay.test${path}`, method: "POST", authorization: authorizationOf(credential) };
    if (random() < failureRate) throw new PlatformError("unreachable", `${platform}: timeout`, { request });
    if (credential.method === "oauth" && credential.expiresAt <= options.now()) {
      throw new PlatformError("unauthorized", `${platform}: HTTP 401`, {
        request,
        status: 401,
        body: '{"error":{"code":401,"status":"UNAUTHENTICATED","message":"Request had invalid authentication credentials."}}',
      });
    }
  }

  function adapter(platform: Platform, oauth: boolean): PlatformAdapter {
    const base: PlatformAdapter = {
      platform,
      probe: (credential) => call(platform, "/me", credential),
      async send(credential: Credential, item: RunItem) {
        await call(platform, "/send", credential);
        return { externalId: `${platform}-${item.id}` };
      },
    };
    if (!oauth) return base;
    return {
      ...base,
      async refresh(credential: Credential) {
        await latency();
        const current = credential as OAuthCredential;
        issued += 1;
        return { ...current, accessToken: `sandbox-${platform}-${issued}`, expiresAt: options.now() + TOKEN_LIFETIME_S * 1000 };
      },
    };
  }

  return {
    google: adapter("google", true),
    meta: adapter("meta", true),
    twilio: adapter("twilio", false),
    linkedin: adapter("linkedin", false),
  };
}
