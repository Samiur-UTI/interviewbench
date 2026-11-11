// One circuit per connection. When a platform keeps failing (outage, throttling) we stop calling
// it for a while instead of piling retries on top of it: every call short-circuits with
// CircuitOpenError until `openMs` has passed, then a single trial call decides whether it closes.
import { PlatformError } from "./errors.ts";
import type { PlatformErrorCause } from "./errors.ts";
import type { BreakerConfig } from "../shared/config.ts";
import type { Scheduler } from "../shared/scheduler.ts";

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  readonly connectionId: string;
  /** When the next trial call will be let through (scheduler time). */
  readonly retryAt: number;

  constructor(connectionId: string, retryAt: number) {
    super(`circuit open for ${connectionId}`);
    this.name = "CircuitOpenError";
    this.connectionId = connectionId;
    this.retryAt = retryAt;
  }
}

interface Circuit {
  failures: number;
  openedAt?: number;
  trialInFlight: boolean;
}

/** Only outages count. A rejected credential says nothing about the health of the platform. */
function isOutage(cause: PlatformErrorCause): boolean {
  return cause === "unreachable" || cause === "rate_limited";
}

export class CircuitBreaker {
  private readonly circuits = new Map<string, Circuit>();
  private readonly scheduler: Scheduler;
  private readonly config: BreakerConfig;

  constructor(scheduler: Scheduler, config: BreakerConfig) {
    this.scheduler = scheduler;
    this.config = config;
  }

  state(connectionId: string): CircuitState {
    const circuit = this.circuits.get(connectionId);
    if (!circuit || circuit.openedAt === undefined) return "closed";
    return this.scheduler.now() >= circuit.openedAt + this.config.openMs ? "half_open" : "open";
  }

  /** True while calls are short-circuited (a half-open circuit lets its trial call through). */
  isOpen(connectionId: string): boolean {
    return this.state(connectionId) === "open";
  }

  /** When an open circuit lets the next call through; undefined while it is closed. */
  retryAt(connectionId: string): number | undefined {
    const openedAt = this.circuits.get(connectionId)?.openedAt;
    return openedAt === undefined ? undefined : openedAt + this.config.openMs;
  }

  async call<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    const circuit = this.circuit(connectionId);
    const state = this.state(connectionId);
    if (state === "open" || (state === "half_open" && circuit.trialInFlight)) {
      throw new CircuitOpenError(connectionId, this.retryAt(connectionId) ?? this.scheduler.now());
    }
    const trial = state === "half_open";
    if (trial) circuit.trialInFlight = true;
    try {
      const value = await fn();
      this.record(connectionId, "ok");
      return value;
    } catch (error) {
      if (error instanceof PlatformError) this.record(connectionId, error.cause);
      throw error;
    } finally {
      if (trial) circuit.trialInFlight = false;
    }
  }

  /**
   * Records the outcome of a platform call made outside `call`. "ok", and any answer from the
   * platform (even a rejected credential) during a trial, closes the circuit; outages count toward
   * opening it.
   */
  record(connectionId: string, outcome: "ok" | PlatformErrorCause): void {
    const circuit = this.circuit(connectionId);
    const state = this.state(connectionId);
    if (outcome === "ok" || (!isOutage(outcome) && state === "half_open")) {
      circuit.failures = 0;
      circuit.openedAt = undefined;
      return;
    }
    if (!isOutage(outcome)) return;
    circuit.failures += 1;
    if (state === "half_open" || (state === "closed" && circuit.failures >= this.config.failureThreshold)) {
      circuit.openedAt = this.scheduler.now();
    }
  }

  reset(connectionId: string): void {
    this.circuits.delete(connectionId);
  }

  private circuit(connectionId: string): Circuit {
    let circuit = this.circuits.get(connectionId);
    if (!circuit) {
      circuit = { failures: 0, trialInFlight: false };
      this.circuits.set(connectionId, circuit);
    }
    return circuit;
  }
}
