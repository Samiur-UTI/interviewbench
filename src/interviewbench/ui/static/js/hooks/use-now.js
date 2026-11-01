// The server's time, refreshed on an interval. Only components that call this re-render on the tick.

import { now } from "../core/clock.js";
import { useEffect, useState } from "../preact.js";

export function useNow(intervalMs = 1000) {
  const [time, setTime] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => setTime(now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return time;
}
