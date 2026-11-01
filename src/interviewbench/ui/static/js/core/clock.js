// The server's clock. Countdowns use it, so a wrong browser clock can't change the time left.

import { parseTime } from "./format.js";

let skew = 0;  // server clock minus browser clock, in ms

export function syncClock(serverTime) {
  const server = parseTime(serverTime);
  if (server !== null) skew = server - Date.now();
}

export function now() {
  return Date.now() + skew;
}
