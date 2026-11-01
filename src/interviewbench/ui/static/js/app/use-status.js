// Keeps /api/status fresh and tracks the connection: online, offline, or needing the private link.

import { api, connection } from "../core/api.js";
import { syncClock } from "../core/clock.js";
import { useCallback, useEffect, useRef, useState } from "../preact.js";

const POLL_MS = 15000;
const POLL_OFFLINE_MS = 3000;

export function useStatus() {
  const [status, setStatus] = useState(null);
  const [ready, setReady] = useState(false);  // the first answer, or failure, has arrived
  const [online, setOnline] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(false);
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    clearTimeout(timer.current);
    let wait = POLL_MS;
    try {
      const next = await api.status();
      syncClock(next.now);
      setStatus(next);
    } catch (err) {
      if (err.status === 401) return;
      wait = POLL_OFFLINE_MS;
    } finally {
      setReady(true);
    }
    timer.current = setTimeout(refresh, wait);
  }, []);

  useEffect(() => {
    const auth = () => setNeedsAuth(true);
    const up = () => {
      setOnline(true);
      refresh();
    };
    const down = () => setOnline(false);
    connection.addEventListener("auth", auth);
    connection.addEventListener("online", up);
    connection.addEventListener("offline", down);
    refresh();
    return () => {
      clearTimeout(timer.current);
      connection.removeEventListener("auth", auth);
      connection.removeEventListener("online", up);
      connection.removeEventListener("offline", down);
    };
  }, [refresh]);

  const updateSettings = useCallback((settings) => {
    setStatus((current) => current && { ...current, settings });
  }, []);

  return { status, ready, online, needsAuth, refresh, updateSettings };
}
