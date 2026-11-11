// Turns the server's probe results into the status each connection card shows. The rules are
// README's "Connectivity" section; this module is where they live. The server only answers checks
// (one platform call each) and pushes every result: deciding whether a failure is real is ours.
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

interface Tracked {
  status: ConnectionStatus;
  /** Consecutive `unauthorized` results in the current confirmation. */
  strikes: number;
  /** The pending confirming check, if any (at most one per connection). */
  timer?: unknown;
  /** checkedAt of the newest result applied, so a re-sent snapshot doesn't count it twice. */
  lastCheckedAt?: number;
}

export function createConnectivityMonitor(options: MonitorOptions): ConnectivityMonitor {
  const { config, send, scheduler, onChange } = options;
  const connections = new Map<string, Tracked>();
  /** Set while a connection's first status is worked out: nothing was shown before it. */
  let initialising = false;

  function setStatus(connectionId: string, entry: Tracked, status: ConnectionStatus): void {
    const previous = entry.status;
    entry.status = status;
    if (previous !== status && !initialising) onChange?.(connectionId, status, previous);
  }

  function cancelCheck(entry: Tracked): void {
    if (entry.timer === undefined) return;
    scheduler.clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  /** One confirming check, `confirmIntervalMs` after the result that called for it arrived. */
  function scheduleCheck(connectionId: string, entry: Tracked): void {
    if (entry.timer !== undefined) return;
    entry.timer = scheduler.setTimeout(() => {
      entry.timer = undefined;
      send({ type: "probe", connectionId });
    }, config.confirmIntervalMs);
  }

  function apply(connectionId: string, entry: Tracked, result: ProbeResult): void {
    entry.lastCheckedAt = result.checkedAt;
    if (result.ok) {
      cancelCheck(entry);
      entry.strikes = 0;
      setStatus(connectionId, entry, "connected");
      return;
    }
    if (result.cause === "circuit_open") {
      // Rule 3: the platform is down, not the credential. Wait for the next pushed result.
      cancelCheck(entry);
      entry.strikes = 0;
      setStatus(connectionId, entry, "paused");
      return;
    }
    // Rule 1 and 2: only a success (or an open circuit) ends Disconnected.
    if (entry.status === "disconnected") return;
    if (result.cause === "unauthorized") {
      entry.strikes += 1;
      if (entry.strikes >= config.confirmAttempts) {
        cancelCheck(entry);
        setStatus(connectionId, entry, "disconnected");
        return;
      }
    }
    // unauthorized not yet confirmed, unreachable, rate_limited: keep checking.
    setStatus(connectionId, entry, "checking");
    scheduleCheck(connectionId, entry);
  }

  /** Applies `result`; a connection seen for the first time starts from `connected`, silently. */
  function receive(connectionId: string, result: ProbeResult | undefined, fromSnapshot: boolean): void {
    let entry = connections.get(connectionId);
    const known = entry !== undefined;
    if (!entry) {
      entry = { status: "connected", strikes: 0 };
      connections.set(connectionId, entry);
    }
    if (!result) return;
    // Rule 4 on page load. A later snapshot (a reconnect, a resync) carries the last result we
    // were already sent: apply only results newer than that. Pushed results always count.
    if (fromSnapshot && known && entry.lastCheckedAt !== undefined && result.checkedAt <= entry.lastCheckedAt) return;
    initialising = !known;
    try {
      apply(connectionId, entry, result);
    } finally {
      initialising = false;
    }
  }

  return {
    handle(message) {
      if (message.type === "snapshot") {
        for (const connection of Object.values(message.state.connections)) receive(connection.id, connection.lastProbe, true);
      } else if (message.type === "probe") {
        receive(message.result.connectionId, message.result, false);
      }
    },

    statusOf(connectionId) {
      const entry = connections.get(connectionId);
      if (!entry) throw new RangeError(`unknown connection ${connectionId}`);
      return entry.status;
    },

    stop() {
      for (const entry of connections.values()) cancelCheck(entry);
    },
  };
}
