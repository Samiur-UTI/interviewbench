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

/** Characters that could end or re-mode a script element, plus U+2028 and U+2029 (JS line terminators). */
const SCRIPT_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/**
 * JSON for the text of a `<script type="application/json">` element. The browser ends the element
 * at the first `</script` whatever is inside it, and `<!--` changes how it looks for that end, so
 * platform text (lead names, headlines) must not be able to spell either. These characters only
 * occur inside JSON strings, where a `\uXXXX` escape means the same character: `JSON.parse` of
 * the element's text gives back exactly the same state.
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(SCRIPT_UNSAFE, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

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
    <script id="__STATE__" type="application/json">${serializeForScript(state)}</script>
    <script type="module" src="/src/client/main.ts"></script>
  </body>
</html>
`;
}
