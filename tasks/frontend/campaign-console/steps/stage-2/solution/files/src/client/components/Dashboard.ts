import { ConnectionCard } from "./ConnectionCard.ts";
import { RunList } from "./RunList.ts";
import { html } from "./html.ts";
import type { ReconnectOutcome } from "../api.ts";
import type { ConnectionStatus } from "../connectivity.ts";
import type { DashboardState, ReconnectRequest } from "../../shared/types.ts";

export interface DashboardProps {
  state: DashboardState;
  statusOf: (connectionId: string) => ConnectionStatus;
  onCheck?: (connectionId: string) => void;
  onReconnect?: (connectionId: string, body: ReconnectRequest) => Promise<ReconnectOutcome>;
}

/**
 * What the live region says: the newest pause or resume of a run (several runs resumed by one
 * reconnect are named together). Derived from the events, so the page rendered on the server and a
 * fresh snapshot say the same as the page that saw it happen.
 */
export function runNotice(state: DashboardState): string {
  let newest = -Infinity;
  let notices: string[] = [];
  for (const [runId, events] of Object.entries(state.events)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type !== "paused" && event.type !== "resumed") continue;
      const run = state.runs[runId];
      if (event.type === "paused" && run?.status !== "paused") break; // since resumed by an operator
      const campaign = (run && state.campaigns[run.campaignId]?.name) ?? runId;
      const notice = `${event.type === "resumed" ? "Resumed" : "Paused"}: ${campaign}`;
      if (event.at > newest) {
        newest = event.at;
        notices = [notice];
      } else if (event.at === newest) {
        notices.push(notice);
      }
      break; // the newest pause or resume of this run is enough
    }
  }
  return notices.join(". ");
}

export function Dashboard({ state, statusOf, onCheck, onReconnect }: DashboardProps) {
  const connections = Object.values(state.connections);
  const runs = Object.values(state.runs).sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));

  return html`
    <div class="console">
      <p class="visually-hidden" role="status" aria-live="polite">${runNotice(state)}</p>
      <header class="topbar">
        <span class="logo">Relay</span>
        <span class="product">Campaign console</span>
      </header>
      <main>
        <section class="connections" aria-labelledby="connections-title">
          <h2 id="connections-title">Connections</h2>
          <div class="cards">
            ${connections.map(
              (connection) =>
                html`<${ConnectionCard}
                  key=${connection.id}
                  connection=${connection}
                  status=${statusOf(connection.id)}
                  onCheck=${onCheck}
                  onReconnect=${onReconnect}
                />`,
            )}
          </div>
        </section>
        <section class="activity" aria-labelledby="runs-title">
          <h2 id="runs-title">Runs</h2>
          <${RunList} runs=${runs} campaigns=${state.campaigns} events=${state.events} />
        </section>
      </main>
    </div>
  `;
}
