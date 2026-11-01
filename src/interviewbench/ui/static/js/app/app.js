// The app frame: picks the screen for the route, and owns the connection banner and the 401 screen.

import { Button } from "../components/button.js";
import { Icon } from "../components/icon.js";
import { Fragment, html, useEffect, useMemo, useRef, useState } from "../preact.js";
import { AppContext } from "./app-context.js";
import { HowToDialog } from "./howto.js";
import { StatusBar } from "./status-bar.js";
import { TopBar } from "./top-bar.js";
import { useRoute } from "./use-route.js";
import { useStatus } from "./use-status.js";
import { VIEWS } from "./views.js";

function ConnectionBanner({ hidden, retry }) {
  return html`
    <div class="banner" role="alert" hidden=${hidden}>
      ${!hidden && html`
        <${Icon} name="alert" />
        <span>Can't reach the server. It may have stopped, or the computer went to sleep. Your work is safe in its folder. Trying again…</span>
        <${Button} kind="ghost small" onClick=${retry}>Try now<//>`}
    </div>`;
}

function AuthRequired() {
  return html`
    <div class="page">
      <div class="state">
        <h2>Open the link ib ui printed</h2>
        <p>This page can only talk to the server through the private link shown in the terminal where you ran ib ui. Open that link, or start ib ui again to get a new one.</p>
        <${Button} icon="refresh" onClick=${() => location.reload()}>Reload<//>
      </div>
    </div>`;
}

// A new screen starts at the top with focus on the page, so keyboard users don't lose their place.
function useScreenChange(route) {
  const main = useRef(null);
  const first = useRef(true);
  useEffect(() => {
    if (!route) return;
    document.title = `${route.title} · interviewbench`;
    if (first.current) {
      first.current = false;
      return;
    }
    main.current.scrollTop = 0;
    main.current.focus({ preventScroll: true });
  }, [route?.key]);
  return main;
}

export function App() {
  const route = useRoute();
  const { status, ready, online, needsAuth, refresh, updateSettings } = useStatus();
  const [howTo, setHowTo] = useState(false);
  const main = useScreenChange(route);
  const context = useMemo(
    () => ({ status, updateSettings, showHowTo: () => setHowTo(true) }),
    [status, updateSettings],
  );
  const View = route && VIEWS[route.name];

  return html`
    <${AppContext.Provider} value=${context}>
      <${Fragment}>
        <${TopBar} current=${route?.nav} />
        <${ConnectionBanner} hidden=${online || needsAuth} retry=${refresh} />
        <main id="main" ref=${main} tabindex="-1">
          ${needsAuth
            ? html`<${AuthRequired} />`
            : ready && View && html`<${View} key=${route.key} params=${route.params} />`}
        </main>
        <${StatusBar} status=${status} onHowTo=${context.showHowTo} />
        ${howTo && html`<${HowToDialog} onClose=${() => setHowTo(false)} />`}
      <//>
    <//>`;
}
