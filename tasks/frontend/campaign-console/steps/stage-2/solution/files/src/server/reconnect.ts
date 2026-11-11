// Reconnecting a connection: store the credential the user brought, check it once, and resume the
// runs that were paused because the old one was rejected (docs/protocol.md,
// POST /api/connections/:id/credentials).
import { credentialFromReconnect } from "./credentials.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { toPublicConnection } from "./views.ts";
import type { CircuitBreaker } from "./breaker.ts";
import type { CampaignRunner } from "./runner.ts";
import type { Store } from "./store.ts";
import type { TokenCache } from "./tokens.ts";
import type { Hub } from "./ws.ts";
import type { Scheduler } from "../shared/scheduler.ts";
import type { ReconnectResponse } from "../shared/types.ts";

export interface ReconnectDeps {
  store: Store;
  tokens: TokenCache;
  breakers: CircuitBreaker;
  runner: CampaignRunner;
  hub: Hub;
  scheduler: Scheduler;
}

export class ReconnectService {
  private readonly deps: ReconnectDeps;
  /** One reconnect per connection at a time: a double submit must not interleave two of them. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(deps: ReconnectDeps) {
    this.deps = deps;
  }

  /**
   * Validates `body` for the connection's method (ValidationError names the field) and, only then:
   * stores the credential, drops cached tokens and the connection's circuit, checks it once
   * (stored as lastProbe, pushed as `probe`), pushes `connection`, and if the check is ok resumes
   * every run on this connection paused for a rejected credential (each pushed as `run`).
   * Rejects NotFoundError for an unknown connection.
   */
  reconnect(connectionId: string, body: unknown): Promise<ReconnectResponse> {
    const previous = this.queues.get(connectionId) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.run(connectionId, body));
    const tail = job.catch(() => {});
    this.queues.set(connectionId, tail);
    void tail.then(() => {
      if (this.queues.get(connectionId) === tail) this.queues.delete(connectionId);
    });
    return job;
  }

  private async run(connectionId: string, body: unknown): Promise<ReconnectResponse> {
    const { store, tokens, breakers, runner, hub, scheduler } = this.deps;
    const connection = store.getConnection(connectionId);
    if (!connection) throw new NotFoundError("connection", connectionId);
    const credential = credentialFromReconnect(connection, body, scheduler.now());

    store.updateConnection(connectionId, { credential });
    // Without these the next call would send the cached (rejected) token, or not reach the
    // platform at all because of an open circuit, and the run would pause again at once.
    tokens.invalidate(connectionId);
    breakers.reset(connectionId);

    const probe = await hub.requestProbe(connectionId);
    const stored = store.getConnection(connectionId);
    if (!stored) throw new NotFoundError("connection", connectionId);
    const view = toPublicConnection(stored);
    hub.broadcast({ type: "connection", connection: view });

    const resumed: string[] = [];
    if (probe.ok) {
      // Only runs this credential stopped: an operator's pause is the operator's to lift.
      const paused = store.listRuns().filter((r) => r.connectionId === connectionId && r.status === "paused" && r.pausedReason === "unauthorized");
      for (const run of paused) {
        try {
          await runner.resume(run.id);
          resumed.push(run.id);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error; // changed under us: not ours to resume
        }
      }
    }
    return { connection: view, probe, resumed };
  }
}
