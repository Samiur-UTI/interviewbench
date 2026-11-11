import { ConnectionCard } from "./ConnectionCard.ts";
import { RunList } from "./RunList.ts";
import { html } from "./html.ts";
import type { ConnectionStatus } from "../connectivity.ts";
import type { DashboardState, PublicConnection } from "../../shared/types.ts";

export interface DashboardProps {
  state: DashboardState;
  statusOf: (connectionId: string) => ConnectionStatus;
  onCheck?: (connectionId: string) => void;
  onReconnect?: (connection: PublicConnection) => void;
}

export function Dashboard({ state, statusOf, onCheck, onReconnect }: DashboardProps) {
  const connections = Object.values(state.connections);
  const runs = Object.values(state.runs).sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));

  return html`
    <div class="console">
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
