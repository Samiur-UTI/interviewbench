// Loads data for a component. A stale answer is dropped, and a failed load retries by itself when the
// server comes back, so no view has to remember to.

import { connection } from "../core/api.js";
import { useCallback, useEffect, useRef, useState } from "../preact.js";

// `initial` shows something at once (say, a remembered copy) while the fresh data loads.
export function useAsync(load, deps = [], initial = null) {
  const [state, setState] = useState({ data: initial, error: null, loading: true });
  const latest = useRef(0);
  const failed = useRef(false);

  const reload = useCallback(async () => {
    const call = ++latest.current;
    setState((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await load();
      failed.current = false;
      if (call === latest.current) setState({ data, error: null, loading: false });
    } catch (error) {
      failed.current = true;
      if (call === latest.current) setState((current) => ({ ...current, error, loading: false }));
    }
  }, deps);

  useEffect(() => {
    reload();
    return () => {
      latest.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    const retry = () => failed.current && reload();
    connection.addEventListener("online", retry);
    return () => connection.removeEventListener("online", retry);
  }, [reload]);

  const set = useCallback((data) => setState({ data, error: null, loading: false }), []);
  return { ...state, reload, set };
}
