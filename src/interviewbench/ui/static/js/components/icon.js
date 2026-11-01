// Hand-drawn stroke icons on a 16 px grid.

import { html } from "../preact.js";

const RING = "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z";

const PATHS = {
  alert: ["M8 2.2 14.8 13.5H1.2z", "M8 6.5v3.2", "M8 11.6v.1"],
  "arrow-left": ["M13 8H3", "M7 4 3 8l4 4"],
  "arrow-right": ["M3 8h10", "M9 4l4 4-4 4"],
  check: ["M3 8.5 6.5 12 13 4.5"],
  copy: ["M5.5 5.5h8v8h-8z", "M10.5 5.5v-3h-8v8h3"],
  cross: ["M4 4l8 8", "M12 4l-8 8"],
  crack: ["M9 1.5 5.5 7l4 2-3 5.5"],
  diff: ["M4 2.5v11", "M8.5 4.5h5", "M11 2v5", "M8.5 11.5h5"],
  editor: ["M1.5 3h13v10h-13z", "M6 6 4 8l2 2", "M10 6l2 2-2 2"],
  flask: ["M6 2h4", "M6.5 2v4.5L3 12.8a1.1 1.1 0 0 0 1 1.7h8a1.1 1.1 0 0 0 1-1.7L9.5 6.5V2"],
  gauge: ["M2 12a6 6 0 1 1 12 0", "M8 12l3-4.5"],
  info: [RING, "M8 7.5v3.5", "M8 5v.1"],
  lock: ["M3.5 7.5h9v6.5h-9z", "M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"],
  moon: ["M13.5 9.7A6 6 0 1 1 6.3 2.5a4.8 4.8 0 0 0 7.2 7.2z"],
  play: ["M5 3.5v9l7.5-4.5z"],
  plus: ["M8 3v10", "M3 8h10"],
  refresh: ["M13.5 8a5.5 5.5 0 1 1-1.6-3.9", "M13.5 1.8V5h-3.2"],
  ring: [RING],
  sun: ["M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M8 1.5v1.5", "M8 13v1.5", "M1.5 8H3", "M13 8h1.5",
        "M3.4 3.4l1.1 1.1", "M11.5 11.5l1.1 1.1", "M3.4 12.6l1.1-1.1", "M11.5 4.5l1.1-1.1"],
  trash: ["M2.5 4h11", "M6 4V2.5h4V4", "M4 4l.7 9.5h6.6L12 4", "M6.8 6.5v4.5", "M9.2 6.5v4.5"],
};

export function Icon({ name }) {
  return html`
    <svg viewBox="0 0 16 16" width="16" height="16" class="icon" aria-hidden="true">
      ${PATHS[name].map((d) => html`<path d=${d} />`)}
    </svg>`;
}
