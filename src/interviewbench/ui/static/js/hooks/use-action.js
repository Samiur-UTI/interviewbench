// Short calls that tie up a button. Long work runs as a job instead.

import { useCallback, useEffect, useRef, useState } from "../preact.js";

// Returns [busy, error, act]: `act(fn)` runs fn once at a time, and keeps the message if it throws.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const act = useCallback(async (fn) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  return [busy, error, act];
}
