// Executes campaign runs: one item at a time, in order, through the connection's platform.
// Transient failures are retried with backoff (retry.ts). When a platform stays down the run doesn't
// burn through its targets or give up: it waits for the connection's circuit (breaker.ts) and tries
// the same item again.
import { CircuitOpenError } from "./breaker.ts";
import { NotFoundError, PlatformError, ValidationError } from "./errors.ts";
import { withRetry } from "./retry.ts";
import { sleep } from "../shared/scheduler.ts";
import type { CircuitBreaker } from "./breaker.ts";
import type { PlatformRegistry } from "./platforms/types.ts";
import type { NewEvent, Store } from "./store.ts";
import type { TokenCache } from "./tokens.ts";
import type { Config } from "../shared/config.ts";
import type { Scheduler } from "../shared/scheduler.ts";
import type { Connection, Run, RunEvent, RunItem } from "../shared/types.ts";

export interface RunnerOptions {
  store: Store;
  platforms: PlatformRegistry;
  tokens: TokenCache;
  breakers: CircuitBreaker;
  scheduler: Scheduler;
  config: Config;
  /** In [0, 1); retry jitter. */
  random: () => number;
}

const PLATFORM_NAMES: Record<string, string> = { google: "Google Ads", meta: "Meta", twilio: "Twilio", linkfolio: "Linkfolio" };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CampaignRunner {
  private readonly options: RunnerOptions;
  private readonly active = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  /**
   * Runs `runId` from its progress.nextIndex. Resolves when the run completes, fails or is paused;
   * calling it again while the run is executing returns the same promise.
   */
  start(runId: string): Promise<void> {
    const existing = this.active.get(runId);
    if (existing) return existing;
    const run = this.options.store.getRun(runId);
    if (!run) return Promise.reject(new NotFoundError("run", runId));
    if (run.status === "completed" || run.status === "failed") {
      return Promise.reject(new ValidationError(`run ${runId} is ${run.status}`, "status"));
    }
    const job = this.execute(runId).finally(() => this.active.delete(runId));
    this.active.set(runId, job);
    return job;
  }

  /** Runs in progress stop at their next step. Used on shutdown. */
  stop(): void {
    this.stopped = true;
  }

  private async execute(runId: string): Promise<void> {
    const { store, scheduler, config } = this.options;
    const initial = this.updateRun(runId, { status: "running" });
    const connection = store.getConnection(initial.connectionId);
    const campaign = store.getCampaign(initial.campaignId);
    if (!connection) {
      this.addEvent(runId, { type: "failed", message: `Connection ${initial.connectionId} no longer exists` });
      this.updateRun(runId, { status: "failed" });
      return;
    }
    const platformName = PLATFORM_NAMES[connection.platform] ?? connection.platform;
    const itemLabel = campaign?.itemLabel ?? "Item";

    while (!this.stopped) {
      const run = store.getRun(runId)!;
      if (run.status !== "running") return; // paused from the ops tool
      const index = run.progress.nextIndex;
      if (index >= run.items.length) {
        this.updateRun(runId, { status: "completed" });
        this.addEvent(runId, { type: "completed", message: `${run.progress.sent} of ${run.progress.total} sent` });
        return;
      }
      const item = run.items[index];
      const target = item.target;
      try {
        await this.sendItem(runId, connection, item);
        if (this.stopped) return;
        const progress = store.getRun(runId)!.progress;
        this.updateRun(runId, { progress: { ...progress, nextIndex: index + 1, sent: progress.sent + 1 } });
        this.addEvent(runId, { type: "sent", message: `${itemLabel} sent to ${target.name}`, target });
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof PlatformError && error.cause === "unauthorized") {
          this.addEvent(runId, { type: "failed", message: error.message, detail: error.details, target });
          this.updateRun(runId, { status: "failed" });
          return;
        }
        // The platform is down or throttling us. Wait for the circuit to let calls through again,
        // then retry the same item: the targets are still owed their message.
        // (A circuit whose trial call is still in flight has no reopening time ahead of it.)
        const waitMs =
          error instanceof CircuitOpenError && error.retryAt > scheduler.now()
            ? error.retryAt - scheduler.now()
            : config.breaker.openMs;
        this.addEvent(runId, {
          type: "retry",
          message: `${platformName} is unavailable (${describe(error)}); trying ${target.name} again in ${Math.ceil(waitMs / 1000)} s`,
          detail: error instanceof PlatformError ? error.details : undefined,
          target,
        });
        await sleep(scheduler, waitMs);
      }
    }
  }

  private sendItem(runId: string, connection: Connection, item: RunItem): Promise<{ externalId: string }> {
    const { platforms, tokens, breakers, scheduler, config, random } = this.options;
    const adapter = platforms[connection.platform];
    let refreshed = false;
    let forceRefresh = false;
    return withRetry(
      async () => {
        const credential = await tokens.getFresh(connection.id, { force: forceRefresh });
        forceRefresh = false;
        return breakers.call(connection.id, () => {
          if (!adapter) throw new PlatformError("unreachable", `no adapter for ${connection.platform}`);
          return adapter.send(credential, item);
        });
      },
      {
        ...config.retry,
        random,
        sleep: (ms) => sleep(scheduler, ms),
        shouldRetry: (error) => {
          if (!(error instanceof PlatformError)) return false;
          if (error.cause === "unauthorized") {
            // The access token may have been revoked or rotated under us: one forced refresh.
            if (connection.method !== "oauth" || refreshed) return false;
            refreshed = forceRefresh = true;
            return true;
          }
          return true; // unreachable, rate_limited
        },
        onRetry: (error, attempt, delayMs) => {
          this.addEvent(runId, {
            type: "retry",
            message: `Attempt ${attempt} for ${item.target.name} failed (${describe(error)}); retrying in ${delayMs} ms`,
            detail: error instanceof PlatformError ? error.details : undefined,
            target: item.target,
          });
        },
      },
    );
  }

  private updateRun(runId: string, patch: Partial<Run>): Run {
    return this.options.store.updateRun(runId, { ...patch, updatedAt: this.options.scheduler.now() });
  }

  private addEvent(runId: string, event: Omit<NewEvent, "at">): RunEvent {
    return this.options.store.appendEvent(runId, { ...event, at: this.options.scheduler.now() });
  }
}
