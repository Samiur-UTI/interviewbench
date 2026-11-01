// The running job's progress, line by line, inside the panel that started it.

import { html } from "../../preact.js";
import { useRoundContext } from "./round-context.js";

export function JobLog() {
  const { job } = useRoundContext();
  return html`<ol class="job-log">${(job?.log ?? []).map((line) => html`<li>${line}</li>`)}</ol>`;
}
