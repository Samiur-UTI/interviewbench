// The dashboard's data, updated from server messages. Pure: every change returns a new state.
import type { ServerMessage } from "../shared/protocol.ts";
import type { DashboardState } from "../shared/types.ts";

export const initialState: DashboardState = { connections: {}, campaigns: {}, runs: {}, events: {} };

export function reduce(state: DashboardState, message: ServerMessage): DashboardState {
  switch (message.type) {
    case "snapshot":
      return message.state;

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
      return { ...state, events: { ...state.events, [message.runId]: [...events, message.event] } };
    }

    default:
      return state;
  }
}
