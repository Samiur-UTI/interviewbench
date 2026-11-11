import { useEffect, useRef, useState } from "../../../vendor/preact/hooks.mjs";
import { html } from "./html.ts";
import { PLATFORM_NAMES, formatDateTime, formatTime } from "./format.ts";
import { ReconnectForm } from "./ReconnectForm.ts";
import type { ReconnectError } from "./ReconnectForm.ts";
import type { ReconnectOutcome } from "../api.ts";
import type { ConnectionStatus } from "../connectivity.ts";
import type { ProbeCause, PublicConnection, ReconnectRequest } from "../../shared/types.ts";

export interface ConnectionCardProps {
  connection: PublicConnection;
  status: ConnectionStatus;
  onCheck?: (connectionId: string) => void;
  /** Sends the reconnect form (createDashboardClient().reconnect). */
  onReconnect?: (connectionId: string, body: ReconnectRequest) => Promise<ReconnectOutcome>;
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

/** Why the check made with the new credential failed, in the user's terms. */
const STILL_FAILING: Record<ProbeCause, (platform: string) => string> = {
  unauthorized: (p) => `${p} rejected this credential too. Check what you pasted and try again.`,
  unreachable: (p) => `The credential is saved, but ${p} couldn't be reached to check it. Try again in a moment.`,
  rate_limited: (p) => `The credential is saved, but ${p} is throttling us. Try again in a moment.`,
  circuit_open: (p) => `The credential is saved, but ${p} is unavailable. Try again in a moment.`,
};

function formatField(key: string, value: string | number): string {
  return key === "expiresAt" && typeof value === "number" ? formatDateTime(value) : String(value);
}

export function ConnectionCard({ connection, status, onCheck, onReconnect }: ConnectionCardProps) {
  const titleId = `connection-${connection.id}-title`;
  const statusId = `connection-${connection.id}-status`;
  const formId = `reconnect-${connection.id}-form`;
  const fields = Object.entries(connection.public ?? {}).filter(([key]) => key in PUBLIC_FIELD_LABELS) as [string, string | number][];
  const lastProbe = connection.lastProbe;
  const platform = PLATFORM_NAMES[connection.platform] ?? connection.platform;

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ReconnectError | undefined>(undefined);
  /** Where focus goes when the form closes: back to Reconnect (cancel) or to the status (success). */
  const [focusAfterClose, setFocusAfterClose] = useState<"button" | "status" | undefined>(undefined);
  const reconnectButton = useRef<HTMLButtonElement | null>(null);
  const statusText = useRef<HTMLParagraphElement | null>(null);
  const card = useRef<HTMLElement | null>(null);

  // The form only makes sense on a dead credential; another viewer's reconnect closes it here too.
  const showForm = open && status === "disconnected";

  useEffect(() => {
    if (showForm) card.current?.querySelector<HTMLInputElement>("form input:not([readonly])")?.focus();
  }, [showForm]);

  useEffect(() => {
    if (open || !focusAfterClose) return;
    (focusAfterClose === "button" ? reconnectButton.current : statusText.current)?.focus();
    setFocusAfterClose(undefined);
  }, [open, focusAfterClose]);

  function close(focus: "button" | "status") {
    setOpen(false);
    setError(undefined);
    setFocusAfterClose(focus);
  }

  async function submit(body: ReconnectRequest) {
    if (!onReconnect || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const outcome = await onReconnect(connection.id, body);
      if (!outcome.ok) setError({ error: outcome.error, field: outcome.field });
      else if (!outcome.probe.ok) setError({ error: "still_failing", message: STILL_FAILING[outcome.probe.cause ?? "unreachable"](platform) });
      else close("status");
    } finally {
      setPending(false);
    }
  }

  return html`
    <article class="card" data-status=${status} aria-labelledby=${titleId} ref=${card}>
      <header class="card-header">
        <h3 id=${titleId}>${platform}</h3>
        <p class="account">${connection.accountName}</p>
      </header>
      <p class="status" id=${statusId} tabindex="-1" ref=${statusText}>
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
        html`<button
          type="button"
          class="primary"
          ref=${reconnectButton}
          aria-describedby=${statusId}
          aria-expanded=${showForm ? "true" : "false"}
          aria-controls=${showForm ? formId : undefined}
          onClick=${() => (showForm ? close("button") : setOpen(true))}
        >
          Reconnect
        </button>`}
      </div>
      ${showForm &&
      html`<${ReconnectForm} connection=${connection} error=${error} pending=${pending} onSubmit=${submit} onCancel=${() => close("button")} />`}
    </article>
  `;
}
