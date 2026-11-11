// Fake platform adapters implementing the app's PlatformAdapter (src/server/platforms/types.ts):
// scripted results, call records, deferred calls that settle only when the test releases them,
// and failures shaped like the real adapters' (the request's authorization in
// `details.request.authorization`, the rejected token quoted in `message`).
//
//   const app = await loadApp();
//   const fakes = createFakePlatforms(app, { clock: scheduler });
//   fakes.twilio.script("probe", "unreachable", "ok");          // then the default (ok)
//   const gate = fakes.google.defer("probe");                    // the next google probe waits
//   await gate.started; ...; gate.release("unauthorized");
//   createApp({ store, platforms: fakes.registry, scheduler });
//
// Failures are built with the app's own PlatformError class (instanceof checks in the breaker and
// the runner depend on it), which is why createFakePlatforms takes the loaded app module.
import type { Module } from "./app.ts";

export type Platform = "google" | "meta" | "twilio" | "linkedin";
export type Cause = "unauthorized" | "unreachable" | "rate_limited";
export type Method = "probe" | "send" | "refresh";

/**
 * What one call does:
 * - "ok": probe resolves, send resolves { externalId }, refresh issues a new token (oauth fakes)
 * - a cause: throws PlatformError(cause) shaped like the real adapters' errors
 * - { fail, message?, details? }: the same, with your own message and/or details
 * - { externalId } (send) or { credential } (refresh): resolves with that value
 * - a function: called with (credential, item) and its result (or rejection) is used as is
 */
export type Outcome =
  | "ok"
  | Cause
  | { fail: Cause; message?: string; details?: unknown }
  | { externalId: string }
  | { credential: any }
  | ((credential: any, item?: any) => unknown);

export interface Call {
  method: Method;
  credential: any;
  item?: any;
  /** Clock time when the call arrived (the fake's clock, or Date.now()). */
  at: number;
  /** The token the credential carries (see tokenOf). */
  token: string;
}

export interface Gate {
  /** Resolves when a call has reached this gate. */
  started: Promise<Call>;
  /** True once a call reached this gate. */
  readonly reached: boolean;
  /** Lets the waiting call (or the next one to arrive) finish with `outcome` (default "ok"). */
  release(outcome?: Outcome): void;
}

export interface FakeOptions {
  /** Clock for refreshed tokens' expiresAt and for expiry checks; share the test's FakeScheduler. */
  clock?: { now(): number };
  /** oauth fakes reject credentials whose expiresAt <= clock.now() as unauthorized (default true). */
  rejectExpired?: boolean;
  /**
   * Failures quote the token in `message` and attach `{ request: { url, method, authorization } }`
   * as `details`, like the real Google/Twilio adapters (default true).
   */
  leakSecrets?: boolean;
  /** Lifetime of refreshed tokens (default 3600 s, as Google's token endpoint). */
  tokenLifetimeMs?: number;
}

/** The secret a credential authenticates with: accessToken, apiKeySecret or the li_at cookie. */
export function tokenOf(credential: any): string {
  if (!credential || typeof credential !== "object") return "";
  if (credential.method === "oauth") return String(credential.accessToken);
  if (credential.method === "api_key") return String(credential.apiKeySecret);
  if (credential.method === "session") return String(credential.cookies?.li_at);
  return "";
}

/** What the real adapters put on the wire for this credential. */
export function authorizationOf(credential: any): string {
  if (credential?.method === "oauth") return `Bearer ${credential.accessToken}`;
  if (credential?.method === "api_key") {
    return `Basic ${Buffer.from(`${credential.apiKeySid}:${credential.apiKeySecret}`).toString("base64")}`;
  }
  if (credential?.method === "session") return `li_at=${credential.cookies?.li_at}; JSESSIONID="${credential.cookies?.JSESSIONID}"`;
  return "";
}

const OAUTH: Record<Platform, boolean> = { google: true, meta: true, twilio: false, linkedin: false };
const PATHS: Record<Method, string> = { probe: "/health", send: "/send", refresh: "/token" };

type QueueEntry = { outcome: Outcome } | { gate: GateState };

interface GateState {
  outcome?: Outcome;
  released: boolean;
  reached: boolean;
  onReach: (call: Call) => void;
  onRelease: () => void;
  wait: Promise<void>;
}

export class FakeAdapter {
  readonly platform: Platform;
  /** Every call, in arrival order. */
  readonly calls: Call[] = [];
  /** Default outcome per method once the script is used up. */
  readonly defaults: Record<Method, Outcome> = { probe: "ok", send: "ok", refresh: "ok" };
  /** When set, probe/send with a token outside this set fail as unauthorized (scripts win). */
  validTokens: Set<string> | undefined;
  /** Tokens issued by refresh, in order. */
  readonly issued: string[] = [];
  refresh?: (credential: any) => Promise<any>;

  private readonly app: Module;
  private readonly options: FakeOptions;
  private readonly queues: Record<Method, QueueEntry[]> = { probe: [], send: [], refresh: [] };

  constructor(app: Module, platform: Platform, options: FakeOptions = {}) {
    this.app = app;
    this.platform = platform;
    this.options = options;
    if (OAUTH[platform]) this.refresh = (credential) => this.handle("refresh", credential);
  }

  probe(credential: any): Promise<void> {
    return this.handle("probe", credential) as Promise<void>;
  }

  send(credential: any, item: any): Promise<{ externalId: string }> {
    return this.handle("send", credential, item) as Promise<{ externalId: string }>;
  }

  /** Queues outcomes for the next calls of `method`, in order. */
  script(method: Method, ...outcomes: Outcome[]): this {
    for (const outcome of outcomes) this.queues[method].push({ outcome });
    return this;
  }

  /** Sets what `method` does once its script is used up. */
  always(method: Method, outcome: Outcome): this {
    this.defaults[method] = outcome;
    return this;
  }

  /** The next call of `method` (after anything already scripted) waits until the gate is released. */
  defer(method: Method): Gate {
    let onReach!: (call: Call) => void;
    let onRelease!: () => void;
    const started = new Promise<Call>((resolve) => (onReach = resolve));
    const wait = new Promise<void>((resolve) => (onRelease = resolve));
    const state: GateState = { released: false, reached: false, onReach, onRelease, wait };
    this.queues[method].push({ gate: state });
    return {
      started,
      get reached() {
        return state.reached;
      },
      release(outcome: Outcome = "ok") {
        if (state.released) return;
        state.released = true;
        state.outcome = outcome;
        onRelease();
      },
    };
  }

  /** Calls of `method` so far (all methods when omitted). */
  count(method?: Method): number {
    return method ? this.calls.filter((c) => c.method === method).length : this.calls.length;
  }

  /** Credentials passed to `method`, in order. */
  credentials(method: Method): any[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.credential);
  }

  /** Items sent, in order. */
  get sentItems(): any[] {
    return this.calls.filter((c) => c.method === "send").map((c) => c.item);
  }

  /** Forgets recorded calls (scripts and defaults are kept). */
  resetCalls(): void {
    this.calls.length = 0;
  }

  /** Builds the PlatformError this fake throws for `cause`. */
  error(cause: Cause, credential: any, method: Method = "probe", custom: { message?: string; details?: unknown } = {}): Error {
    const leak = this.options.leakSecrets ?? true;
    const token = tokenOf(credential);
    const status = cause === "unauthorized" ? 401 : cause === "rate_limited" ? 429 : 503;
    const message =
      custom.message ?? (leak && cause === "unauthorized" ? `${this.platform}: credential ${token} was rejected` : `${this.platform}: HTTP ${status}`);
    const details =
      "details" in custom
        ? custom.details
        : leak
          ? {
              request: { url: `https://fake.${this.platform}.test${PATHS[method]}`, method: "POST", authorization: authorizationOf(credential) },
              status,
              body: cause === "unauthorized" ? `{"error":"invalid token ${token}"}` : "",
            }
          : { status };
    return new this.app.PlatformError(cause, message, details);
  }

  private now(): number {
    return this.options.clock?.now() ?? Date.now();
  }

  private async handle(method: Method, credential: any, item?: any): Promise<unknown> {
    const call: Call = { method, credential: structuredClone(credential), item, at: this.now(), token: tokenOf(credential) };
    this.calls.push(call);
    const entry = this.queues[method].shift();
    let outcome: Outcome | undefined;
    if (entry && "gate" in entry) {
      entry.gate.reached = true;
      entry.gate.onReach(call);
      await entry.gate.wait;
      outcome = entry.gate.outcome ?? "ok";
    } else if (entry) {
      outcome = entry.outcome;
    }
    if (outcome === undefined) outcome = this.implicitFailure(method, credential) ?? this.defaults[method];
    return this.apply(outcome, method, credential, item);
  }

  /** Unscripted calls: an expired oauth token or one outside validTokens is rejected. */
  private implicitFailure(method: Method, credential: any): Outcome | undefined {
    if (method === "refresh") return undefined;
    if (this.validTokens && !this.validTokens.has(tokenOf(credential))) return "unauthorized";
    const rejectExpired = this.options.rejectExpired ?? true;
    if (rejectExpired && credential?.method === "oauth" && typeof credential.expiresAt === "number" && credential.expiresAt <= this.now()) {
      return "unauthorized";
    }
    return undefined;
  }

  private async apply(outcome: Outcome, method: Method, credential: any, item?: any): Promise<unknown> {
    if (typeof outcome === "function") return outcome(credential, item);
    if (outcome === "ok") {
      if (method === "probe") return undefined;
      if (method === "send") return { externalId: `${this.platform}-${item?.id ?? this.count("send")}` };
      return this.issue(credential);
    }
    if (typeof outcome === "string") throw this.error(outcome, credential, method);
    if ("fail" in outcome) throw this.error(outcome.fail, credential, method, outcome);
    if ("externalId" in outcome) return { externalId: outcome.externalId };
    return outcome.credential;
  }

  /** A refreshed oauth credential with a new long alphanumeric token. */
  private issue(credential: any): any {
    const n = this.issued.length + 1;
    const token = `${this.platform}Refreshed${n}${"Q7wE2rT9yU4iO1pA6sD3fG8hJ5kL0zX".slice(0, 32)}`;
    this.issued.push(token);
    const fresh: any = {
      ...credential,
      accessToken: token,
      expiresAt: this.now() + (this.options.tokenLifetimeMs ?? 3_600_000),
    };
    if (this.platform === "meta") delete fresh.refreshToken;
    return fresh;
  }
}

export interface FakePlatforms {
  google: FakeAdapter;
  meta: FakeAdapter;
  twilio: FakeAdapter;
  linkedin: FakeAdapter;
  /** Pass as createApp({ platforms }). */
  registry: Record<Platform, FakeAdapter>;
  all: FakeAdapter[];
  /** Calls of `method` across every platform. */
  count(method?: Method): number;
}

/** One fake per platform. `only` limits the registry (a platform without an adapter is unreachable). */
export function createFakePlatforms(app: Module, options: FakeOptions & { only?: Platform[] } = {}): FakePlatforms {
  const make = (platform: Platform) => new FakeAdapter(app, platform, options);
  const fakes = { google: make("google"), meta: make("meta"), twilio: make("twilio"), linkedin: make("linkedin") };
  const all = Object.values(fakes);
  const registry = Object.fromEntries(
    all.filter((f) => !options.only || options.only.includes(f.platform)).map((f) => [f.platform, f]),
  ) as Record<Platform, FakeAdapter>;
  return { ...fakes, registry, all, count: (method) => all.reduce((sum, f) => sum + f.count(method), 0) };
}
