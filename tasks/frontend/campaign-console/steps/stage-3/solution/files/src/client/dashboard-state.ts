// The dashboard's data, updated from server messages. Pure: every change returns a new state.
import type { ServerMessage } from "../shared/protocol.ts";
import type { DashboardState, PublicEvent } from "../shared/types.ts";

export const initialState: DashboardState = { connections: {}, campaigns: {}, runs: {}, events: {} };

/** `events` and `more` merged by id, ascending, each id once (`more`'s copy wins). */
export function mergeEvents(events: PublicEvent[], more: PublicEvent[]): PublicEvent[] {
  if (more.length === 0) return events;
  const byId = new Map<number, PublicEvent>();
  for (const event of events) byId.set(event.id, event);
  for (const event of more) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * A run's events after a snapshot. The snapshot has only the newest ones; older events this
 * dashboard already holds (received live, or loaded with "Load earlier events") are kept when
 * they join up with the snapshot's without a hole. Otherwise the snapshot's list is what we know.
 */
function eventsAfterSnapshot(mine: PublicEvent[] | undefined, theirs: PublicEvent[]): PublicEvent[] {
  if (!mine || mine.length === 0 || theirs.length === 0) return theirs;
  const first = theirs[0].id;
  const last = mine[mine.length - 1].id;
  if (mine[0].id >= first || last < first - 1 || last > theirs[theirs.length - 1].id) return theirs;
  return [...mine.filter((e) => e.id < first), ...theirs];
}

/** Earlier events of a run (GET /api/runs/:id/events) added in front of the ones held. */
export function withEarlierEvents(state: DashboardState, runId: string, earlier: PublicEvent[]): DashboardState {
  if (earlier.length === 0) return state;
  return { ...state, events: { ...state.events, [runId]: mergeEvents(state.events[runId] ?? [], earlier) } };
}

export function reduce(state: DashboardState, message: ServerMessage): DashboardState {
  switch (message.type) {
    case "snapshot": {
      const events: DashboardState["events"] = {};
      for (const [runId, list] of Object.entries(message.state.events)) events[runId] = eventsAfterSnapshot(state.events[runId], list);
      return { ...message.state, events };
    }

    case "probe": {
      const { result } = message;
      const connection = state.connections[result.connectionId];
      if (!connection) return state;
      return { ...state, connections: { ...state.connections, [connection.id]: { ...connection, lastProbe: result } } };
    }

    case "connection":
      // A reconnect replaced the credential: new public identifiers, and the check made with it.
      return { ...state, connections: { ...state.connections, [message.connection.id]: message.connection } };

    case "run":
      return { ...state, runs: { ...state.runs, [message.run.id]: message.run } };

    case "event": {
      const events = state.events[message.runId] ?? [];
      if (events.some((e) => e.id === message.event.id)) return state;
      // The run's total moves with it (a `run` message carries the server's count, too).
      const run = state.runs[message.runId];
      const runs = run && typeof run.eventCount === "number" ? { ...state.runs, [run.id]: { ...run, eventCount: run.eventCount + 1 } } : state.runs;
      return { ...state, runs, events: { ...state.events, [message.runId]: mergeEvents(events, [message.event]) } };
    }

    default:
      return state;
  }
}
