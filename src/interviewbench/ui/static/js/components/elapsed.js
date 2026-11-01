// How long a job has been going. Ticks by itself, so its parent doesn't re-render every second.

import { formatElapsed, parseTime } from "../core/format.js";
import { useNow } from "../hooks/use-now.js";
import { html } from "../preact.js";

export function Elapsed({ since }) {
  const time = useNow();
  return html`<span class="job-time">${since ? formatElapsed(time - parseTime(since)) : ""}</span>`;
}
