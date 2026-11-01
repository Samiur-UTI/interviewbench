// The current route, from the address bar. An address that isn't a route goes to the home screen.

import { HOME, parseRoute } from "../core/routes.js";
import { useEffect, useState } from "../preact.js";

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const update = () => {
      const next = parseRoute(location.hash);
      if (next) setRoute(next);
      else location.replace(HOME);
    };
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
