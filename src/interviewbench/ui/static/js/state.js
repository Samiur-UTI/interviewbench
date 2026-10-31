// App-wide state the views share, and the browser storage that remembers per-browser choices.

import { parseTime } from "./format.js";

export const app = {
  status: null,  // the last GET /api/status
  skew: 0,  // server clock minus browser clock, in ms
};

export function setStatus(status) {
  app.status = status;
  const serverNow = parseTime(status.now);
  if (serverNow !== null) app.skew = serverNow - Date.now();
}

// The server's "now". Countdowns use this, so a wrong browser clock can't change the time left.
export function now() {
  return Date.now() + app.skew;
}

// Storage can throw in private windows. These are conveniences, so failing is fine.
export function remember(key, value) {
  try {
    localStorage.setItem(`ib.${key}`, JSON.stringify(value));
  } catch {
    // not remembered
  }
}

export function recall(key, fallback) {
  try {
    const stored = localStorage.getItem(`ib.${key}`);
    return stored === null ? fallback : JSON.parse(stored);
  } catch {
    return fallback;
  }
}
