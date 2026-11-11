// Domain types shared by the server and the browser. The per-platform details (what each
// credential holds, what is secret, what is public) are in docs/platforms/.

export type Platform = "google" | "meta" | "twilio" | "linkedin";

/** How we authenticate against a platform. google and meta use oauth, twilio api_key, linkedin session. */
export type Method = "oauth" | "api_key" | "session";

/**
 * google, meta. `expiresAt` is a ms epoch (platforms send `expires_in` in seconds). Google gives us a
 * refresh token; Meta doesn't (its long-lived token is renewed by exchanging it while it is valid).
 */
export interface OAuthCredential {
  method: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
}

/** twilio. Requests authenticate with the API key (basic auth apiKeySid:apiKeySecret). */
export interface ApiKeyCredential {
  method: "api_key";
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
}

/** linkedin. The two cookies are the session; the user agent must match the browser that logged in. */
export interface SessionCredential {
  method: "session";
  cookies: { li_at: string; JSESSIONID: string };
  userAgent: string;
  profileUrl: string;
}

export type Credential = OAuthCredential | ApiKeyCredential | SessionCredential;

/** The parts of a credential the browser may see, per method. */
export type PublicCredential =
  | { method: "oauth"; scope: string; expiresAt: number }
  | { method: "api_key"; accountSid: string; apiKeySid: string }
  | { method: "session"; userAgent: string; profileUrl: string };

/** Why a health check failed. `circuit_open` means we did not call the platform at all. */
export type ProbeCause = "unauthorized" | "unreachable" | "rate_limited" | "circuit_open";

export interface ProbeResult {
  connectionId: string;
  ok: boolean;
  cause?: ProbeCause;
  checkedAt: number;
}

/** A customer's credential for one platform, as stored. Server-side only. */
export interface Connection {
  id: string;
  platform: Platform;
  method: Method;
  label: string;
  accountName: string;
  credential: Credential;
  lastProbe?: ProbeResult;
  createdAt: number;
}

/** What the browser may see of a connection. */
export interface PublicConnection {
  id: string;
  platform: Platform;
  method: Method;
  label: string;
  accountName: string;
  lastProbe?: ProbeResult;
  public: PublicCredential;
}

export interface Campaign {
  id: string;
  name: string;
  platform: Platform;
  connectionId: string;
  /** What one item is on this platform, for display ("SMS", "Connection request", ...). */
  itemLabel: string;
  createdAt: number;
}

/**
 * One send. `target` is who it is for, as the platform described them; `payload` is what the
 * platform's adapter needs (phone number and text, ad group and headline, profile and note, ...).
 */
export interface RunItem {
  id: string;
  target: { name: string; headline?: string };
  payload: Record<string, unknown>;
}

export type RunStatus = "queued" | "running" | "paused" | "completed" | "failed";

export interface RunProgress {
  /** Index of the first item not sent yet. */
  nextIndex: number;
  sent: number;
  total: number;
}

export interface Run {
  id: string;
  campaignId: string;
  connectionId: string;
  status: RunStatus;
  /** "user": paused by an operator from the ops tool. */
  pausedReason?: "user" | "unauthorized";
  progress: RunProgress;
  items: RunItem[];
  startedAt: number;
  updatedAt: number;
}

export type PublicRun = Omit<Run, "items">;

export type RunEventType = "sent" | "retry" | "failed" | "paused" | "resumed" | "completed";

export interface RunEvent {
  /** 1, 2, 3, ... per run. */
  id: number;
  runId: string;
  at: number;
  type: RunEventType;
  message: string;
  /** Diagnostics for support (platform error details and the like). */
  detail?: unknown;
  target?: { name: string; headline?: string };
}

export type PublicEvent = Omit<RunEvent, "detail">;

/**
 * The body of `POST /api/connections/:id/credentials`, by the connection's method. What each
 * platform hands us on a reconnect is in docs/platforms/ ("Reconnecting").
 */
export interface OAuthReconnect {
  accessToken: string;
  /** Google only, and only when the consent issued a new one: without it the stored one is kept. */
  refreshToken?: string;
  /** Seconds, as the platform's token endpoint says it (`expires_in`). */
  expiresIn: number;
}

export interface ApiKeyReconnect {
  /** Must be the connection's account: a different account is a new connection. */
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
}

export interface SessionReconnect {
  cookies: { li_at: string; JSESSIONID: string };
  userAgent: string;
}

export type ReconnectRequest = OAuthReconnect | ApiKeyReconnect | SessionReconnect;

/** 200 answer of `POST /api/connections/:id/credentials`. */
export interface ReconnectResponse {
  /** As stored after the check: its lastProbe is `probe`. */
  connection: PublicConnection;
  /** The one check made with the new credential. */
  probe: ProbeResult;
  /** Runs that were paused for a rejected credential and are running again (empty unless probe.ok). */
  resumed: string[];
}

/**
 * Everything the dashboard renders. Records are keyed by id; `events` by run id, each list in
 * ascending id order (oldest first).
 */
export interface DashboardState {
  connections: Record<string, PublicConnection>;
  campaigns: Record<string, Campaign>;
  runs: Record<string, PublicRun>;
  events: Record<string, PublicEvent[]>;
}
