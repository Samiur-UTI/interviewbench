// Everything the dashboard does with server messages, without the DOM: the page (main.ts) and
// the server-side render both drive this.
import * as api from "./api.ts";
import { createConnectivityMonitor } from "./connectivity.ts";
import { initialState, reduce, withEarlierEvents } from "./dashboard-state.ts";
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
  /**
   * "Load earlier events" on a run: fetches the page of events just before the oldest one held
   * (GET /api/runs/:id/events) and adds it in front, ascending. Calls made while one is in flight
   * for the same run share it, so a double click adds nothing twice. Resolves once the state has
   * them; never rejects (a failed request changes nothing).
   */
  loadEarlierEvents(runId: string): Promise<void>;
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
  /** seq of the last broadcast applied; undefined until a numbered snapshot arrives. */
  let lastSeq: number | undefined;
  /** A snapshot was asked for to fill a gap and hasn't arrived yet. */
  let resyncing = false;
  const loading = new Map<string, Promise<void>>();

  function changed(): void {
    options.onState?.(state);
  }

  function handle(message: ServerMessage): void {
    if (message.type === "snapshot") {
      // The whole state as of its seq: whatever came before it is in it. (A new socket after a
      // server restart starts again from a lower seq; the snapshot is still the truth.)
      if (typeof message.seq === "number") lastSeq = message.seq;
      resyncing = false;
    } else if (message.type !== "error" && typeof message.seq === "number") {
      if (lastSeq !== undefined && message.seq <= lastSeq) return; // already applied
      if (lastSeq !== undefined && message.seq > lastSeq + 1 && !resyncing) {
        // Something between them never reached us: a fresh snapshot repairs whatever it was.
        resyncing = true;
        options.send({ type: "snapshot" });
      }
      lastSeq = message.seq;
    }
    state = reduce(state, message);
    monitor.handle(message);
    changed();
  }

  async function loadEarlier(runId: string): Promise<void> {
    const held = state.events[runId] ?? [];
    const oldest = held[0];
    const run = state.runs[runId];
    if (oldest?.id === 1 || (run && typeof run.eventCount === "number" && held.length >= run.eventCount)) return; // nothing older
    let page: Awaited<ReturnType<typeof api.earlierEvents>>;
    try {
      page = await api.earlierEvents(runId, oldest?.id, http);
    } catch (error) {
      console.warn(`loading earlier events of ${runId} failed`, error);
      return;
    }
    state = withEarlierEvents(state, runId, page.events);
    changed();
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
        changed();
      }
      return outcome;
    },
    loadEarlierEvents(runId) {
      const pending = loading.get(runId);
      if (pending) return pending;
      const job = loadEarlier(runId).finally(() => loading.delete(runId));
      loading.set(runId, job);
      return job;
    },
    stop: () => monitor.stop(),
  };
}
