// Turns the server's probe results into the status each connection card shows.
import type { ConnectivityConfig } from "../shared/config.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import type { Scheduler } from "../shared/scheduler.ts";
import type { ProbeResult } from "../shared/types.ts";

export type ConnectionStatus = "connected" | "checking" | "disconnected" | "paused";

export interface MonitorOptions {
  config: ConnectivityConfig;
  /** Sends a message to the server (the dashboard's WebSocket). */
  send: (message: ClientMessage) => void;
  scheduler: Scheduler;
  onChange?: (connectionId: string, status: ConnectionStatus, previous: ConnectionStatus) => void;
}

export interface ConnectivityMonitor {
  /** Feed every server message; the monitor picks the ones it cares about. */
  handle(message: ServerMessage): void;
  /** Throws RangeError for a connection the monitor hasn't heard of. */
  statusOf(connectionId: string): ConnectionStatus;
  /** Cancels pending timers. */
  stop(): void;
}

export function createConnectivityMonitor(options: MonitorOptions): ConnectivityMonitor {
  const { config, send, scheduler, onChange } = options;
  const statuses = new Map<string, ConnectionStatus>();
  const rechecks = new Map<string, unknown>();

  function set(connectionId: string, status: ConnectionStatus): void {
    const previous = statuses.get(connectionId);
    statuses.set(connectionId, status);
    if (previous !== undefined && previous !== status) onChange?.(connectionId, status, previous);
  }

  function cancelRecheck(connectionId: string): void {
    const handle = rechecks.get(connectionId);
    if (handle === undefined) return;
    scheduler.clearTimeout(handle);
    rechecks.delete(connectionId);
  }

  // Ask for another check one interval later, so a card recovers without a page reload once the
  // platform answers again.
  function scheduleRecheck(connectionId: string): void {
    if (rechecks.has(connectionId)) return;
    const handle = scheduler.setTimeout(() => {
      rechecks.delete(connectionId);
      send({ type: "probe", connectionId });
    }, config.probeIntervalMs);
    rechecks.set(connectionId, handle);
  }

  function apply(connectionId: string, result: ProbeResult | undefined): void {
    if (!result || result.ok) {
      cancelRecheck(connectionId);
      set(connectionId, "connected");
      return;
    }
    set(connectionId, "disconnected");
    scheduleRecheck(connectionId);
  }

  return {
    handle(message) {
      if (message.type === "snapshot") {
        for (const connection of Object.values(message.state.connections)) apply(connection.id, connection.lastProbe);
      } else if (message.type === "probe") {
        apply(message.result.connectionId, message.result);
      }
    },

    statusOf(connectionId) {
      const status = statuses.get(connectionId);
      if (status === undefined) throw new RangeError(`unknown connection ${connectionId}`);
      return status;
    },

    stop() {
      for (const handle of rechecks.values()) scheduler.clearTimeout(handle);
      rechecks.clear();
    },
  };
}
