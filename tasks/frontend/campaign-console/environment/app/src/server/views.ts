// What the dashboard gets to see: the page's embedded state, /api responses and WebSocket
// messages are all built from these.
import type { Store } from "./store.ts";
import type {
  Campaign,
  Connection,
  DashboardState,
  PublicConnection,
  PublicEvent,
  PublicRun,
  Run,
  RunEvent,
} from "../shared/types.ts";

export function toPublicConnection(connection: Connection): PublicConnection {
  return { ...connection } as unknown as PublicConnection;
}

/** Runs without their items: a run can target thousands of contacts. */
export function toPublicRun(run: Run): PublicRun {
  const { items: _items, ...rest } = run;
  return rest;
}

export function toPublicEvent(event: RunEvent): PublicEvent {
  return { ...event };
}

export function toDashboardState(store: Store): DashboardState {
  const connections: Record<string, PublicConnection> = {};
  for (const connection of store.listConnections()) connections[connection.id] = toPublicConnection(connection);
  const campaigns: Record<string, Campaign> = {};
  for (const campaign of store.listCampaigns()) campaigns[campaign.id] = campaign;
  const runs: Record<string, PublicRun> = {};
  const events: Record<string, PublicEvent[]> = {};
  for (const run of store.listRuns()) {
    runs[run.id] = toPublicRun(run);
    events[run.id] = store.listEvents(run.id).map(toPublicEvent);
  }
  return { connections, campaigns, runs, events };
}
