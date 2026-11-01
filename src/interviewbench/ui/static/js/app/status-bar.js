// The bottom of every page: can tests run on this computer, and which editor opens.

import { Icon } from "../components/icon.js";
import { html } from "../preact.js";

function Item({ state, icon, children }) {
  return html`<span class=${`status-item ${state}`}><${Icon} name=${icon} />${children}</span>`;
}

export function StatusBar({ status, onHowTo }) {
  if (!status) return html`<footer class="statusbar"><span class="status-item">Checking this computer…</span></footer>`;
  const { docker, bash, default: runner } = status.runner;
  const usable = runner === "docker" ? docker : runner ? bash : false;
  return html`
    <footer class="statusbar">
      ${usable
        ? html`<${Item} state="ok" icon="check">Tests run: ${runner === "docker" ? "in Docker" : "on this computer"}<//>`
        : html`<${Item} state="warn" icon="alert">No way to run tests: start Docker or install Git Bash<//>`}
      ${docker
        ? html`<${Item} state="ok" icon="check">Docker running<//>`
        : html`<${Item} state="off" icon="ring">Docker not running<//>`}
      ${status.editor
        ? html`<${Item} state="ok" icon="check">Editor: ${status.editor}<//>`
        : html`<${Item} state="off" icon="ring">No editor found<//>`}
      <span class="status-spacer"></span>
      <button type="button" class="link-button" onClick=${onHowTo}>How a round works</button>
      <span class="status-item">v${status.version}</span>
    </footer>`;
}
