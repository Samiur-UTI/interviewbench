// Light or dark: the candidate's choice if they made one, else the system's.

import { recall, remember } from "../core/storage.js";
import { useCallback, useEffect, useState } from "../preact.js";

const DARK = "(prefers-color-scheme: dark)";

export function useTheme() {
  const [chosen, setChosen] = useState(() => recall("theme", null));
  const [systemDark, setSystemDark] = useState(() => matchMedia(DARK).matches);

  useEffect(() => {
    const media = matchMedia(DARK);
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (chosen) document.documentElement.dataset.theme = chosen;
  }, [chosen]);

  const theme = chosen ?? (systemDark ? "dark" : "light");
  const toggle = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setChosen(next);
    remember("theme", next);
    return next;
  }, [theme]);

  return { theme, toggle };
}
