// Small bridges to things that live outside the component tree.

import { useEffect, useLayoutEffect, useRef } from "../preact.js";

// Aborted when the component unmounts, for work that outlives a render, such as following a job.
export function useAbortSignal() {
  const controller = useRef(null);
  if (!controller.current) controller.current = new AbortController();
  useEffect(() => () => controller.current.abort(), []);
  return controller.current.signal;
}

// Runs fn when the candidate comes back to this window, say from their editor.
export function useWindowFocus(fn) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const onFocus = () => latest.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}

// Fits the screen to the window: its panes scroll, not the page.
export function useFixedMain(fixed) {
  useLayoutEffect(() => {
    const main = document.getElementById("main");
    main.classList.toggle("fixed", fixed);
    return () => main.classList.remove("fixed");
  }, [fixed]);
}
