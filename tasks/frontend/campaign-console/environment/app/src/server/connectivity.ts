// Health checks ("probes") of a connection's credential. The dashboard shows their results on the
// connection cards; README "Connectivity" says how the browser interprets them.
import { CircuitOpenError } from "./breaker.ts";
import { PlatformError } from "./errors.ts";
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

  /** Checks the connection once and records the result as its lastProbe. */
  async probe(connectionId: string): Promise<ProbeResult> {
    const { store, platforms, tokens, breaker, scheduler } = this.options;
    const connection = store.getConnection(connectionId)!;
    const adapter = platforms[connection.platform];
    // Probes run on a schedule for every open dashboard: use the credential we already hold rather
    // than adding token traffic of our own.
    const credential = tokens.peek(connectionId) ?? connection.credential;

    let result: ProbeResult;
    try {
      await breaker.call(connectionId, () => {
        if (!adapter) throw new PlatformError("unreachable", `no adapter for ${connection.platform}`);
        return adapter.probe(credential);
      });
      result = { connectionId, ok: true, checkedAt: scheduler.now() };
    } catch (error) {
      result = { connectionId, ok: false, cause: probeCause(error), checkedAt: scheduler.now() };
    }
    store.updateConnection(connectionId, { lastProbe: result });
    return result;
  }
}
