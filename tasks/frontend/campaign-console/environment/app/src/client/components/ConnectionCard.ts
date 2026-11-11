import { html } from "./html.ts";
import { PLATFORM_NAMES, formatDateTime, formatTime } from "./format.ts";
import type { ConnectionStatus } from "../connectivity.ts";
import type { PublicConnection } from "../../shared/types.ts";

export interface ConnectionCardProps {
  connection: PublicConnection;
  status: ConnectionStatus;
  onCheck?: (connectionId: string) => void;
  onReconnect?: (connection: PublicConnection) => void;
}

export const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connected: "Connected",
  checking: "Checking…",
  disconnected: "Disconnected",
  paused: "Paused (platform unavailable)",
};

const PUBLIC_FIELD_LABELS: Record<string, string> = {
  accountSid: "Account SID",
  apiKeySid: "API key",
  scope: "Scope",
  expiresAt: "Token expires",
  userAgent: "Browser",
  profileUrl: "Profile",
};

function formatField(key: string, value: string | number): string {
  return key === "expiresAt" && typeof value === "number" ? formatDateTime(value) : String(value);
}

export function ConnectionCard({ connection, status, onCheck, onReconnect }: ConnectionCardProps) {
  const titleId = `connection-${connection.id}-title`;
  const statusId = `connection-${connection.id}-status`;
  const fields = Object.entries(connection.public ?? {}).filter(([key]) => key in PUBLIC_FIELD_LABELS) as [string, string | number][];
  const lastProbe = connection.lastProbe;

  return html`
    <article class="card" data-status=${status} aria-labelledby=${titleId}>
      <header class="card-header">
        <h3 id=${titleId}>${PLATFORM_NAMES[connection.platform] ?? connection.platform}</h3>
        <p class="account">${connection.accountName}</p>
      </header>
      <p class="status" id=${statusId}>
        <span class="dot" aria-hidden="true"></span>
        ${STATUS_TEXT[status]}
      </p>
      ${fields.length > 0 &&
      html`<dl class="fields">
        ${fields.map(([key, value]) => html`<div key=${key}><dt>${PUBLIC_FIELD_LABELS[key]}</dt><dd>${formatField(key, value)}</dd></div>`)}
      </dl>`}
      <p class="checked">${lastProbe ? `Last checked ${formatTime(lastProbe.checkedAt)}` : "Not checked yet"}</p>
      <div class="actions">
        <button type="button" onClick=${() => onCheck?.(connection.id)}>Check now</button>
        ${status === "disconnected" &&
        html`<button type="button" class="primary" onClick=${() => onReconnect?.(connection)}>Reconnect</button>`}
      </div>
    </article>
  `;
}
