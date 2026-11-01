// One changed file as a readable diff.

import { html, useState } from "../../../preact.js";

const OPEN_LINES = 300;  // larger files start collapsed
const STATUS = { added: ["ok", "Added"], deleted: ["fail", "Deleted"], modified: ["accent", "Modified"] };
const SIGN = { add: "+", del: "-", context: " ", note: "" };

function DiffLine({ line }) {
  return html`
    <div class=${`diff-line ${line.type}`}>
      <span class="diff-num">${line.oldLine ?? ""}</span>
      <span class="diff-num">${line.newLine ?? ""}</span>
      <span class="diff-sign">${SIGN[line.type]}</span>
      <span class="diff-text">${line.text}</span>
    </div>`;
}

function Hunks({ path, hunks }) {
  return html`
    <div class="diff-scroll" tabindex="0" role="group" aria-label=${`Diff of ${path}`}>
      <div class="diff-body">
        ${hunks.map((hunk) => html`
          <div class="diff-hunk">${hunk.header}</div>
          ${hunk.lines.map((line) => html`<${DiffLine} line=${line} />`)}`)}
      </div>
    </div>`;
}

// `summary` is the file from the API, `parsed` its part of the parsed diff, if the diff reached it.
export function FileDiff({ summary, parsed }) {
  const [kind, label] = STATUS[summary.status] ?? STATUS.modified;
  const lines = parsed?.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0;
  const startsOpen = lines <= OPEN_LINES;
  const [opened, setOpened] = useState(startsOpen);  // a collapsed file costs nothing until it's opened
  const toggled = (event) => {
    if (event.target.open) setOpened(true);
  };
  return html`
    <details class="diff-file" open=${startsOpen} onToggle=${toggled}>
      <summary>
        <span class=${`badge ${kind}`}>${label}</span>
        <code class="diff-path">${summary.path}</code>
        <span class="diff-counts">
          <span class="added">+${summary.additions}</span>${" "}
          <span class="removed">-${summary.deletions}</span>
        </span>
      </summary>
      ${lines
        ? opened && html`<${Hunks} path=${summary.path} hunks=${parsed.hunks} />`
        : html`<p class="meta diff-none">${parsed?.binary ? "Binary file: no preview." : "No preview for this file."}</p>`}
    </details>`;
}
