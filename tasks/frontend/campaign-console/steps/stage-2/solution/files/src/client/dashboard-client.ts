// Everything the dashboard does with server messages, without the DOM: the page (main.ts) and
// the server-side render both drive this.
import * as api from "./api.ts";
import { createConnectivityMonitor } from "./connectivity.ts";
import { initialState, reduce } from "./dashboard-state.ts";
import type { ConnectionStatus } from "./connectivity.ts";
import type { Config } from "../shared/config.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import type { Scheduler } from "../shared/scheduler.ts";
import type { ReconnectOutcome } from "./api.ts";
import type { DashboardState, ReconnectRequest } from "../shared/types.ts";

export interface DashboardClientOptions {
  config: Config;
  scheduler: Scheduler;
  /** Sends a message on the dashboard's WebSocket. */
  send: (message: ClientMessage) => void;
  /** Called after every change, to re-render. */
  onState?: (state: DashboardState) => void;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface DashboardClient {
  handle(message: ServerMessage): void;
  state(): DashboardState;
  statusOf(connectionId: string): ConnectionStatus;
  /** "Check now" on a card. The result comes back to every dashboard as a probe message. */
  check(connectionId: string): Promise<void>;
  /**
   * Sends a new credential for the connection (POST /api/connections/:id/credentials). On success
   * the answer's connection and check are applied at once, as if they had been pushed: a check that
   * passed shows the card Connected without waiting for the next message. Never rejects.
   */
  reconnect(connectionId: string, body: ReconnectRequest): Promise<ReconnectOutcome>;
  stop(): void;
}

export function createDashboardClient(options: DashboardClientOptions): DashboardClient {
  const http = { fetch: options.fetch, baseUrl: options.baseUrl };
  let state = initialState;
  const monitor = createConnectivityMonitor({
    config: options.config.connectivity,
    send: options.send,
    scheduler: options.scheduler,
  });

  function handle(message: ServerMessage): void {
    state = reduce(state, message);
    monitor.handle(message);
    if (message.type === "run") {
      // A run's counters and its activity list come from different messages; take a fresh
      // snapshot whenever a run changes so the two always agree on screen.
      options.send({ type: "snapshot" });
    }
    options.onState?.(state);
  }

  return {
    handle,
    state: () => state,
    statusOf: (connectionId) => monitor.statusOf(connectionId),
    async check(connectionId) {
      try {
        await api.probe(connectionId, http);
      } catch (error) {
        console.warn(`check of ${connectionId} failed`, error);
      }
    },
    async reconnect(connectionId, body) {
      const outcome = await api.reconnect(connectionId, body, http);
      if (outcome.ok) {
        // The same facts the server also pushes as `connection` and `probe`. Getting them twice is
        // harmless: the form is only offered on a Disconnected card, where a repeated failure
        // changes nothing and a repeated success is still Connected.
        state = reduce(state, { type: "connection", connection: outcome.connection });
        monitor.handle({ type: "probe", result: outcome.probe });
        options.onState?.(state);
      }
      return outcome;
    },
    stop: () => monitor.stop(),
  };
}
