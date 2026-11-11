// In-memory store. Records are replaced, never mutated: anything handed out stays a consistent
// snapshot of the moment it was read. (Production uses Postgres behind the same interface.)
import { NotFoundError } from "./errors.ts";
import type { Campaign, Connection, Run, RunEvent } from "../shared/types.ts";

/** The shape of data/seed.json. Ids: conn_<platform>, camp_<n>, run_<n>; event ids 1, 2, 3, ... per run. */
export interface Seed {
  connections: Connection[];
  campaigns: Campaign[];
  runs: Run[];
  events?: RunEvent[];
}

export type NewEvent = Omit<RunEvent, "id" | "runId">;

/** What changed, delivered to `on` listeners synchronously, after the change is stored. */
export type StoreChange =
  | { kind: "connection"; connection: Connection }
  | { kind: "run"; run: Run }
  | { kind: "event"; runId: string; event: RunEvent };

export type StoreListener = (change: StoreChange) => void;

export interface Store {
  getConnection(id: string): Connection | undefined;
  listConnections(): Connection[];
  /** Shallow-merges `patch` into a copy of the connection. Throws NotFoundError. */
  updateConnection(id: string, patch: Partial<Connection>): Connection;
  getCampaign(id: string): Campaign | undefined;
  listCampaigns(): Campaign[];
  getRun(id: string): Run | undefined;
  listRuns(): Run[];
  /** Shallow-merges `patch` into a copy of the run. Throws NotFoundError. */
  updateRun(id: string, patch: Partial<Run>): Run;
  /** Appends with the run's next id (1, 2, 3, ...). Throws NotFoundError for an unknown run. */
  appendEvent(runId: string, event: NewEvent): RunEvent;
  /** The run's events in ascending id order ([] for a run without events). */
  listEvents(runId: string): RunEvent[];
  /** Subscribes to changes; returns the unsubscribe function. */
  on(listener: StoreListener): () => void;
}

function byId<T extends { id: string }>(records: T[]): Map<string, T> {
  return new Map(records.map((r) => [r.id, r]));
}

export function createStore(seed: Seed): Store {
  const data = structuredClone(seed);
  const connections = byId(data.connections);
  const campaigns = byId(data.campaigns);
  const runs = byId(data.runs);
  const events = new Map<string, RunEvent[]>();
  for (const event of data.events ?? []) {
    const list = events.get(event.runId) ?? [];
    list.push(event);
    events.set(event.runId, list);
  }
  for (const list of events.values()) list.sort((a, b) => a.id - b.id);

  const listeners = new Set<StoreListener>();
  const emit = (change: StoreChange) => {
    for (const listener of [...listeners]) listener(change);
  };

  return {
    getConnection: (id) => connections.get(id),
    listConnections: () => [...connections.values()],
    updateConnection(id, patch) {
      const current = connections.get(id);
      if (!current) throw new NotFoundError("connection", id);
      const connection = { ...current, ...patch, id };
      connections.set(id, connection);
      emit({ kind: "connection", connection });
      return connection;
    },

    getCampaign: (id) => campaigns.get(id),
    listCampaigns: () => [...campaigns.values()],

    getRun: (id) => runs.get(id),
    listRuns: () => [...runs.values()],
    updateRun(id, patch) {
      const current = runs.get(id);
      if (!current) throw new NotFoundError("run", id);
      const run = { ...current, ...patch, id };
      runs.set(id, run);
      emit({ kind: "run", run });
      return run;
    },

    appendEvent(runId, event) {
      if (!runs.has(runId)) throw new NotFoundError("run", runId);
      const list = events.get(runId) ?? [];
      const id = list.length > 0 ? list[list.length - 1].id + 1 : 1;
      const stored: RunEvent = { ...event, id, runId };
      list.push(stored);
      events.set(runId, list);
      emit({ kind: "event", runId, event: stored });
      return stored;
    },
    listEvents: (runId) => [...(events.get(runId) ?? [])],

    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
