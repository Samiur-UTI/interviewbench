// The states every panel must design for, so nothing is ever blank, plus notices and badges.

import { html } from "../preact.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

const NOTICE_ICONS = { ok: "check", warn: "alert", fail: "cross", info: "info" };

export function Loading({ text }) {
  return html`
    <div class="state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>${text}</p>
    </div>`;
}

export function Empty({ title, text, children }) {
  return html`
    <div class="state">
      <h2>${title}</h2>
      ${text && html`<p>${text}</p>`}
      ${children}
    </div>`;
}

export function Failed({ error, retry, title = "That didn't work" }) {
  return html`
    <div class="state error" role="alert">
      <h2><${Icon} name="alert" />${" "}${title}</h2>
      <p>${error.message}</p>
      ${error.status === 0 && html`<p>Check that ib ui is still running, then try again.</p>`}
      ${retry && html`<${Button} icon="refresh" onClick=${retry}>Try again<//>`}
    </div>`;
}

// One useAsync result on screen. `render` gets the data once there is some.
export function Async({ query, loading, failed, render }) {
  if (query.error) return html`<${Failed} error=${query.error} retry=${query.reload} title=${failed} />`;
  if (query.data === null) return html`<${Loading} text=${loading} />`;
  return render(query.data);
}

export function Notice({ kind, children, action }) {
  return html`
    <div class=${`notice ${kind}`}>
      <${Icon} name=${NOTICE_ICONS[kind]} />
      <div class="notice-text">${children}</div>
      ${action}
    </div>`;
}

// Status is never colour alone: every badge carries its label and an icon.
export function Badge({ kind = "", icon, children }) {
  return html`<span class=${`badge ${kind}`}>${icon && html`<${Icon} name=${icon} />`}${children}</span>`;
}
