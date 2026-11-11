// Health checks ("probes") of a connection's credential. The dashboard shows their results on the
// connection cards; README "Connectivity" says how the browser interprets them.
import { CircuitOpenError } from "./breaker.ts";
import { NotFoundError, PlatformError } from "./errors.ts";
import type { CircuitBreaker } from "./breaker.ts";
import type { PlatformRegistry } from "./platforms/types.ts";
import type { Store } from "./store.ts";
import type { TokenCache } from "./tokens.ts";
import type { Scheduler } from "../shared/scheduler.ts";
import type { ProbeCause, ProbeResult } from "../shared/types.ts";

export interface ProbeServiceOptions {
  store: Store;
  platforms: PlatformRegistry;
  tokens: TokenCache;
  breaker: CircuitBreaker;
  scheduler: Scheduler;
}

export function probeCause(error: unknown): ProbeCause {
  if (error instanceof CircuitOpenError) return "circuit_open";
  if (error instanceof PlatformError) return error.cause;
  return "unreachable";
}

export class ProbeService {
  private readonly options: ProbeServiceOptions;

  constructor(options: ProbeServiceOptions) {
    this.options = options;
  }

  /**
   * Checks the connection once (one platform call, through its circuit breaker) and records the
   * result as its lastProbe. Rejects NotFoundError for an unknown connection.
   *
   * The check sends the same credential a campaign would send now: TokenCache.getFresh, which
   * refreshes an access token about to expire and shares a refresh already in flight. A check
   * with a cached token that has since expired would report a working connection as rejected.
   */
  async probe(connectionId: string): Promise<ProbeResult> {
    const { store, platforms, tokens, breaker, scheduler } = this.options;
    const connection = store.getConnection(connectionId);
    if (!connection) throw new NotFoundError("connection", connectionId);
    const adapter = platforms[connection.platform];

    let result: ProbeResult;
    try {
      await breaker.call(connectionId, async () => {
        if (!adapter) throw new PlatformError("unreachable", `no adapter for ${connection.platform}`);
        await adapter.probe(await tokens.getFresh(connectionId));
      });
      result = { connectionId, ok: true, checkedAt: scheduler.now() };
    } catch (error) {
      if (error instanceof NotFoundError) throw error; // removed while we were checking it
      result = { connectionId, ok: false, cause: probeCause(error), checkedAt: scheduler.now() };
    }
    store.updateConnection(connectionId, { lastProbe: result });
    return result;
  }
}
