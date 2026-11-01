// Short calls that tie up a button. Long work runs as a job instead.

import { useCallback, useEffect, useRef, useState } from "../preact.js";

// Returns [busy, run]: `run(fn)` sets busy while fn is going, and ignores a second press.
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (fn) => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  return [busy, run];
}
