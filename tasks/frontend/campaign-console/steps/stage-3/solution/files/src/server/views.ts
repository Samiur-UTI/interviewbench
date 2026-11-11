// What the browser gets to see. The page's embedded state, every /api response and every
// WebSocket message are built from these, so this is the one boundary secrets must not cross
// (README, rule 2). Every shape is built field by field from an allow-list: a field added to a
// stored record (a credential, an adapter's error details) stays on the server until someone
// decides here that the browser may see it.
import { config } from "../shared/config.ts";
import type { Store } from "./store.ts";
import type {
  Campaign,
  Connection,
  Credential,
  DashboardState,
  ProbeResult,
  PublicConnection,
  PublicCredential,
  PublicEvent,
  PublicRun,
  Run,
  RunEvent,
} from "../shared/types.ts";

/** The public identifiers of a credential, per method (docs/platforms/). */
export function toPublicCredential(credential: Credential): PublicCredential {
  switch (credential.method) {
    case "oauth":
      return { method: "oauth", scope: credential.scope, expiresAt: credential.expiresAt };
    case "api_key":
      return { method: "api_key", accountSid: credential.accountSid, apiKeySid: credential.apiKeySid };
    case "session":
      return { method: "session", userAgent: credential.userAgent, profileUrl: credential.profileUrl };
  }
}

export function toPublicProbe(result: ProbeResult): ProbeResult {
  const view: ProbeResult = { connectionId: result.connectionId, ok: result.ok, checkedAt: result.checkedAt };
  if (result.cause !== undefined) view.cause = result.cause;
  return view;
}

export function toPublicConnection(connection: Connection): PublicConnection {
  const view: PublicConnection = {
    id: connection.id,
    platform: connection.platform,
    method: connection.method,
    label: connection.label,
    accountName: connection.accountName,
    public: toPublicCredential(connection.credential),
  };
  if (connection.lastProbe) view.lastProbe = toPublicProbe(connection.lastProbe);
  return view;
}

/**
 * Runs without their items (a run can target thousands of contacts), with the number of events
 * the run has recorded: the browser holds only some of them.
 */
export function toPublicRun(run: Run, eventCount: number): PublicRun {
  const view: PublicRun = {
    id: run.id,
    campaignId: run.campaignId,
    connectionId: run.connectionId,
    status: run.status,
    progress: { nextIndex: run.progress.nextIndex, sent: run.progress.sent, total: run.progress.total },
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    eventCount,
  };
  if (run.pausedReason !== undefined) view.pausedReason = run.pausedReason;
  return view;
}

/**
 * Events without `detail` (diagnostics for support, which can hold whatever an adapter attached
 * to an error). `message` is our own wording (runner.ts); the target is the lead as the platform
 * described them, shown as text.
 */
export function toPublicEvent(event: RunEvent): PublicEvent {
  const view: PublicEvent = { id: event.id, runId: event.runId, at: event.at, type: event.type, message: event.message };
  if (event.target) {
    view.target = { name: event.target.name };
    if (event.target.headline !== undefined) view.target.headline = event.target.headline;
  }
  return view;
}

function toPublicCampaign(campaign: Campaign): Campaign {
  return {
    id: campaign.id,
    name: campaign.name,
    platform: campaign.platform,
    connectionId: campaign.connectionId,
    itemLabel: campaign.itemLabel,
    createdAt: campaign.createdAt,
  };
}

export interface DashboardStateOptions {
  /** Newest events per run to include (config.dashboard.recentEvents). */
  recentEvents: number;
}

/**
 * What a dashboard starts from: every connection, campaign and run, and each run's newest
 * `recentEvents` events (a long run has thousands; GET /api/runs/:id/events pages through the rest).
 * The server passes the app's own config; the default is the shipped one.
 */
export function toDashboardState(store: Store, options: DashboardStateOptions = { recentEvents: config.dashboard.recentEvents }): DashboardState {
  const connections: Record<string, PublicConnection> = {};
  for (const connection of store.listConnections()) connections[connection.id] = toPublicConnection(connection);
  const campaigns: Record<string, Campaign> = {};
  for (const campaign of store.listCampaigns()) campaigns[campaign.id] = toPublicCampaign(campaign);
  const runs: Record<string, PublicRun> = {};
  const events: Record<string, PublicEvent[]> = {};
  const limit = Math.max(0, Math.floor(options.recentEvents));
  for (const run of store.listRuns()) {
    runs[run.id] = toPublicRun(run, store.countEvents(run.id));
    events[run.id] = limit === 0 ? [] : store.listEvents(run.id, { limit }).map(toPublicEvent);
  }
  return { connections, campaigns, runs, events };
}
