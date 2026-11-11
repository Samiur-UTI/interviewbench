// Server-side render of the dashboard. The browser hydrates the same component tree from the
// state embedded in the page (src/client/main.ts), so both go through createDashboardClient.
import { renderToString } from "../../../vendor/preact/render-to-string.mjs";
import { createDashboardClient } from "../../client/dashboard-client.ts";
import { Dashboard } from "../../client/components/Dashboard.ts";
import { html } from "../../client/components/html.ts";
import { config } from "../../shared/config.ts";
import type { Scheduler } from "../../shared/scheduler.ts";
import type { DashboardState } from "../../shared/types.ts";

/** Rendering is a one-off: nothing scheduled while rendering should ever fire. */
const renderScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: () => undefined,
  clearTimeout: () => {},
};

export function renderDashboardPage(state: DashboardState): string {
  const client = createDashboardClient({ config, scheduler: renderScheduler, send: () => {} });
  client.handle({ type: "snapshot", state });
  const body = renderToString(html`<${Dashboard} state=${client.state()} statusOf=${client.statusOf} />`);
  client.stop();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Relay · Campaign console</title>
    <link rel="stylesheet" href="/src/client/styles.css" />
  </head>
  <body>
    <div id="app">${body}</div>
    <script id="__STATE__" type="application/json">${JSON.stringify(state)}</script>
    <script type="module" src="/src/client/main.ts"></script>
  </body>
</html>
`;
}
