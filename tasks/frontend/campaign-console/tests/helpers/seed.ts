// Seeds with known secrets, so tests can search everything the browser receives for them.
// Every secret is a long alphanumeric string (no & < > ' "), so a substring check is exact whatever
// escaping the output uses.

export const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

export const SECRETS = {
  googleAccessToken: "fakegAT7qKp2Lw9XzR4mVb8NcY3dFh6JsE1uTo5WiQ0aZxGkPnHr",
  googleRefreshToken: "fakegRT3vBn8Mq1Lz6Xc4Wk9Pj2Hf7Ds5Ga0Ry8Tu3Ei6Ow1Qp",
  metaAccessToken: "fakemAT9sDf2Gh5Jk8Lz1Xc4Vb7Nm0Qw3Er6Ty9Ui2Op5As8Df1",
  twilioApiKeySecret: "faketKS4hJ7kL0zX3cV6bN9mQ2wE5rT8yU1iO4pA7sD0fG3hJ6kL",
  linkfolioSession: "fakelLA1qW4eR7tY0uI3oP6aS9dF2gH5jK8lZ1xC4vB7nM0qW3eR6",
  linkfolioCsrf: "fakelJS8mN5bV2cX9zL6kJ3hG0fD7sA4pO1iU8yT5rE2wQ9mN6bV3",
} as const;

/** Every secret value in the seed. */
export const ALL_SECRETS: string[] = Object.values(SECRETS);

export const PUBLIC = {
  googleScope: "https://www.googleapis.com/auth/adwords",
  metaScope: "ads_management,ads_read",
  twilioAccountSid: "AC0123456789abcdef0123456789abcdef",
  twilioApiKeySid: "SKfedcba9876543210fedcba9876543210",
  linkfolioUserAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  linkfolioProfileUrl: "https://app.linkfolio.example/in/test-sender",
} as const;

/**
 * Secrets in the encoded forms adapters put on the wire (Twilio's basic auth), which a leaked
 * authorization header would carry instead of the raw value.
 */
export const DERIVED_SECRETS: string[] = [
  Buffer.from(`${"SKfedcba9876543210fedcba9876543210"}:${SECRETS.twilioApiKeySecret}`).toString("base64"),
];

/** Text that breaks out of an unescaped JSON-in-<script> or renders as markup when used as HTML. */
export const HOSTILE = {
  name: '</script><script>window.__pwned = 1</script><!-- Ana',
  headline: '<img src=x onerror="window.__pwned=2"> Head of <em>Growth</em>    </SCRIPT> & co',
};

export type Platform = "google" | "meta" | "twilio" | "linkfolio";
export const PLATFORMS: Platform[] = ["google", "meta", "twilio", "linkfolio"];

export interface SeedOptions {
  now?: number;
  /** Google's access token expiry (default: an hour from now). Past = expired. */
  googleExpiresAt?: number;
  /** Meta's token expiry (default: 40 days from now). */
  metaExpiresAt?: number;
  /** Give every connection an ok lastProbe (default: none, the "never checked" case). */
  lastProbeOk?: boolean;
  /** A lastProbe per platform (wins over lastProbeOk), e.g. { twilio: { ok: false, cause: "unauthorized" } }. */
  lastProbes?: Partial<Record<Platform, { ok: boolean; cause?: string; checkedAt?: number }>>;
  runs?: any[];
  events?: any[];
}

export function connections(options: SeedOptions = {}): any[] {
  const now = options.now ?? NOW;
  const lastProbe = (id: string) => {
    const custom = options.lastProbes?.[id.slice("conn_".length) as Platform];
    if (custom) return { lastProbe: { connectionId: id, checkedAt: now - 60_000, ...custom } };
    return options.lastProbeOk ? { lastProbe: { connectionId: id, ok: true, checkedAt: now - 60_000 } } : {};
  };
  return [
    {
      id: "conn_google",
      platform: "google",
      method: "oauth",
      label: "Google Ads",
      accountName: "Test Outdoor (111-222-3333)",
      credential: {
        method: "oauth",
        accessToken: SECRETS.googleAccessToken,
        refreshToken: SECRETS.googleRefreshToken,
        expiresAt: options.googleExpiresAt ?? now + HOUR,
        scope: PUBLIC.googleScope,
      },
      ...lastProbe("conn_google"),
      createdAt: now - 90 * 24 * HOUR,
    },
    {
      id: "conn_meta",
      platform: "meta",
      method: "oauth",
      label: "Meta",
      accountName: "Test Outdoor (act_1)",
      credential: {
        method: "oauth",
        accessToken: SECRETS.metaAccessToken,
        expiresAt: options.metaExpiresAt ?? now + 40 * 24 * HOUR,
        scope: PUBLIC.metaScope,
      },
      ...lastProbe("conn_meta"),
      createdAt: now - 60 * 24 * HOUR,
    },
    {
      id: "conn_twilio",
      platform: "twilio",
      method: "api_key",
      label: "Twilio",
      accountName: "Test SMS",
      credential: {
        method: "api_key",
        accountSid: PUBLIC.twilioAccountSid,
        apiKeySid: PUBLIC.twilioApiKeySid,
        apiKeySecret: SECRETS.twilioApiKeySecret,
      },
      ...lastProbe("conn_twilio"),
      createdAt: now - 30 * 24 * HOUR,
    },
    {
      id: "conn_linkfolio",
      platform: "linkfolio",
      method: "session",
      label: "Linkfolio",
      accountName: "Test Sender",
      credential: {
        method: "session",
        cookies: { lf_session: SECRETS.linkfolioSession, lf_csrf: SECRETS.linkfolioCsrf },
        userAgent: PUBLIC.linkfolioUserAgent,
        profileUrl: PUBLIC.linkfolioProfileUrl,
      },
      ...lastProbe("conn_linkfolio"),
      createdAt: now - 20 * 24 * HOUR,
    },
  ];
}

/** One campaign per platform: camp_google, camp_meta, camp_twilio, camp_linkfolio. */
export function campaigns(now = NOW): any[] {
  const label: Record<Platform, string> = { google: "Ad", meta: "Ad set update", twilio: "SMS", linkfolio: "Connection request" };
  return PLATFORMS.map((platform) => ({
    id: `camp_${platform}`,
    name: `${platform} campaign`,
    platform,
    connectionId: `conn_${platform}`,
    itemLabel: label[platform],
    createdAt: now - HOUR,
  }));
}

export interface RunSpec {
  id: string;
  platform: Platform;
  /** Number of items (targets "Target 1".. "Target n"), or explicit targets. */
  items: number | { name: string; headline?: string }[];
  status?: "queued" | "running" | "paused" | "completed" | "failed";
  pausedReason?: "user" | "unauthorized";
  nextIndex?: number;
  now?: number;
}

export function makeRun(spec: RunSpec): any {
  const now = spec.now ?? NOW;
  const targets = typeof spec.items === "number" ? Array.from({ length: spec.items }, (_, i) => ({ name: `Target ${i + 1}` })) : spec.items;
  const nextIndex = spec.nextIndex ?? 0;
  return {
    id: spec.id,
    campaignId: `camp_${spec.platform}`,
    connectionId: `conn_${spec.platform}`,
    status: spec.status ?? "queued",
    ...(spec.pausedReason ? { pausedReason: spec.pausedReason } : {}),
    progress: { nextIndex, sent: nextIndex, total: targets.length },
    items: targets.map((target, i) => ({ id: `${spec.id}_item_${i + 1}`, target, payload: { index: i } })),
    startedAt: now - 10 * 60_000,
    updatedAt: now - 60_000,
  };
}

/** A run whose first target has HOSTILE's name and headline, followed by `plain` ordinary targets. */
export function hostileRun(id: string, platform: Platform = "linkfolio", options: Partial<RunSpec> & { plain?: number } = {}): any {
  const plain = Array.from({ length: options.plain ?? 2 }, (_, i) => ({ name: `Target ${i + 2}`, headline: `Headline ${i + 2}` }));
  return makeRun({ status: "running", ...options, id, platform, items: [{ name: HOSTILE.name, headline: HOSTILE.headline }, ...plain] });
}

/** An event for `run` naming its target, as the runner records a send (hostile text included). */
export function sentEvent(runId: string, id: number, target: { name: string; headline?: string }, now = NOW): any {
  return { id, runId, at: now - 30_000 + id, type: "sent", message: `Connection request sent to ${target.name}`, target };
}

/**
 * A stored event as an earlier release recorded it: the adapter's error details, with the request's
 * authorization, kept in `detail` for support. Hidden seeds carry secrets in stored events ONLY in
 * `detail`, never in a stored `message`: migrating old rows is out of scope for the candidate, and
 * messages written from now on are the code's responsibility (checked through the runner).
 */
export function storedDiagnosticsEvent(runId: string, id: number, now = NOW): any {
  return {
    id,
    runId,
    at: now - 120_000 + id,
    type: "retry",
    message: "Attempt 1 for Target 1 failed (twilio: HTTP 401); retrying in 250 ms",
    detail: {
      request: {
        url: "https://api.twilio.com/2010-04-01/Accounts/AC0123456789abcdef0123456789abcdef/Messages.json",
        method: "POST",
        authorization: `Basic ${DERIVED_SECRETS[0]}`,
      },
      status: 401,
      body: `{"code":20003,"message":"Authenticate","key":"${SECRETS.twilioApiKeySecret}"}`,
      session: `lf_session=${SECRETS.linkfolioSession}; lf_csrf="${SECRETS.linkfolioCsrf}"`,
    },
    target: { name: "Target 1" },
  };
}

/** `count` events for a run with ids from..from+count-1, ascending, one second apart. */
export function makeEvents(runId: string, count: number, options: { from?: number; now?: number } = {}): any[] {
  const from = options.from ?? 1;
  const start = (options.now ?? NOW) - count * 1_000;
  return Array.from({ length: count }, (_, i) => ({
    id: from + i,
    runId,
    at: start + i * 1_000,
    type: "sent",
    message: `Item sent to Target ${from + i}`,
    target: { name: `Target ${from + i}` },
  }));
}

/** The four connections, a campaign per platform, and whatever runs/events the test adds. */
export function buildSeed(options: SeedOptions = {}): any {
  return {
    connections: connections(options),
    campaigns: campaigns(options.now ?? NOW),
    runs: options.runs ?? [],
    events: options.events ?? [],
  };
}
