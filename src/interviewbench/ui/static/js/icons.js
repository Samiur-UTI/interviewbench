// Hand-drawn stroke icons on a 16 px grid, built with DOM calls because the CSP allows no markup strings.

const RING = "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z";

const PATHS = {
  alert: ["M8 2.2 14.8 13.5H1.2z", "M8 6.5v3.2", "M8 11.6v.1"],
  "arrow-left": ["M13 8H3", "M7 4 3 8l4 4"],
  "arrow-right": ["M3 8h10", "M9 4l4 4-4 4"],
  check: ["M3 8.5 6.5 12 13 4.5"],
  chevron: ["M4 6l4 4 4-4"],
  clock: [RING, "M8 4.5V8l2.5 1.5"],
  copy: ["M5.5 5.5h8v8h-8z", "M10.5 5.5v-3h-8v8h3"],
  cross: ["M4 4l8 8", "M12 4l-8 8"],
  crack: ["M9 1.5 5.5 7l4 2-3 5.5"],
  diff: ["M4 2.5v11", "M8.5 4.5h5", "M11 2v5", "M8.5 11.5h5"],
  editor: ["M1.5 3h13v10h-13z", "M6 6 4 8l2 2", "M10 6l2 2-2 2"],
  external: ["M7 3H3v10h10V9", "M9.5 2.5h4v4", "M13.5 2.5 7.5 8.5"],
  flag: ["M3.5 14V2.5h9l-2 3 2 3h-9"],
  flask: ["M6 2h4", "M6.5 2v4.5L3 12.8a1.1 1.1 0 0 0 1 1.7h8a1.1 1.1 0 0 0 1-1.7L9.5 6.5V2"],
  folder: ["M1.5 4.5a1 1 0 0 1 1-1h3.6L7.5 5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"],
  gauge: ["M2 12a6 6 0 1 1 12 0", "M8 12l3-4.5"],
  info: [RING, "M8 7.5v3.5", "M8 5v.1"],
  key: ["M10.5 9.5a3.5 3.5 0 1 0-3-3L2.5 11.5v2h2V12H6v-1.5h1"],
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

const SVG = "http://www.w3.org/2000/svg";

export function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
