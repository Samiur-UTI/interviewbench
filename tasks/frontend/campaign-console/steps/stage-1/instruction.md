# Phantom disconnects and a pentest finding

You've joined the team behind Relay, a SaaS console for outbound marketing. Agencies and growth
teams connect their customers' Google Ads, Meta, Twilio and LinkedIn accounts and run campaigns
from one dashboard, which they keep open all day: a card per connection with its live status, and
every campaign run with its progress and activity. This repo is the console: a Node.js server and
a Preact dashboard that is rendered on the server, hydrated in the browser and kept live over a
WebSocket. Read `README.md` first (the product, how a run works, the **Connectivity** rules, the
business **Rules** and this repo's TypeScript constraints), then `docs/`.

Two tickets landed this week.

1. **Support:** "Google campaigns keep sending, yet after about an hour the Google card flips to
   Disconnected / Reconnect and stays there until someone reconnects. Meta and Twilio cards flip
   to Disconnected for a few seconds when those platforms are slow or throttle us. Users click
   Reconnect, which aborts the run. Two LinkedIn customers who reconnected repeatedly got a
   security challenge."
2. **Security:** "A pentester created a LinkedIn lead whose name contained a script tag. Opening
   the dashboard ran it: it read a Twilio API key secret out of the page and posted it to their
   server (we send no Content-Security-Policy), then opened a WebSocket, sent one message, and the
   console went down for every user. The report also lists lead headlines rendering as HTML,
   `/api/connections/<id>` returning the stored credential, and a request for an unknown
   connection id crashing the server."

Find the root causes and fix them. Each ticket may have more than one.

## What must hold afterwards

### Connection status

- README's Connectivity section describes what users must see on a card. It is the
  specification.
- The browser's connectivity monitor (`createConnectivityMonitor`, used by
  `createDashboardClient`) keeps its role: it alone decides what a card shows, per viewer. The
  server answers each probe request (`{ type: "probe", connectionId }` on the WebSocket, or
  `POST /api/connections/:id/probe`) with exactly one platform call, pushes the result to every
  open dashboard, and keeps no confirmation state.
- The monitor takes its numbers from the `config` it is given (`confirmIntervalMs`,
  `confirmAttempts`), has at most one confirming check pending per connection, and `stop()`
  cancels every pending check.
- A card that shows `disconnected` or `paused` requests no checks of its own. It changes only
  when the server pushes a result: an ok result shows `connected`; further failures leave
  `disconnected` as it is.
- `app.probes.probe(connectionId)` rejects with `NotFoundError` for a connection that doesn't
  exist.

### What the browser receives

- **Secrets** are the secret fields of each credential (`docs/platforms/`, and the `Credential`
  types in `src/shared/types.ts`). None may appear in anything the browser receives: the page's
  HTML, any `/api` response, any WebSocket message (`snapshot`, `probe`, `run`, `event`, `error`),
  `lastProbe` or run events. That includes anything a platform adapter attaches to an error
  (`PlatformError`'s `message` and `details`), whatever the adapter put there, and credentials that
  have since been rotated: a token that was refreshed or replaced is still a secret. Events
  already stored may carry an adapter's details for support (the seed has one); they must not
  reach the browser either.
- `PublicConnection.public` holds a connection's public identifiers, by method, exactly as
  `PublicCredential` types it: `oauth` `{ method, scope, expiresAt }`; `api_key`
  `{ method, accountSid, apiKeySid }`; `session` `{ method, userAgent, profileUrl }`. It is in
  `/api/dashboard`, `/api/connections/:id`, the page state and WebSocket snapshots.
- **The page must not execute data.** The state stays in
  `<script id="__STATE__" type="application/json">…</script>`, followed by the module script
  `/src/client/main.ts`. Its text, read the way a browser reads it (everything up to the first
  `</script`, in any letter case, with no entity decoding), must parse with `JSON.parse` to exactly
  the dashboard state, and must contain no `<script` or `<!--` either (in any letter case: a
  browser's parser reacts to both inside a script element); `main.ts` keeps reading it with
  `JSON.parse(el.textContent)`.
- Lead names, headlines and any other platform text still appear on the dashboard, as text: a
  headline containing `<em>` shows the characters `<em>`. Never as markup, and never dropped.

### Nothing a browser sends stops the server

- WebSocket: a message that is not JSON, not a JSON object, has an unknown `type`, or lacks a
  field of the right type gets `{ type: "error", code: "bad_message", message }`. A `probe` for a
  connection that doesn't exist gets `{ type: "error", code: "not_found", message }`. In both cases
  the socket stays open and keeps working. An unmasked frame closes that one socket (1002), as
  RFC 6455 requires of a server; a fragmented or oversized frame may close it too (1002 or 1009).
  None of them affects another socket or the server.
- HTTP: `GET /api/connections/:id` and `POST /api/connections/:id/probe` for an unknown id answer
  404 `{ "error": "not_found" }`. An unexpected error in a request handler answers a 500 with a
  JSON body instead of stopping the server.

## How your work is checked

The hidden tests import `src/index.ts` and `src/client/index.ts`, so keep every export of both
barrels (adding is fine), and the shapes in `src/shared/types.ts` and `src/shared/protocol.ts`.
They:

- build the server with `createApp({ store, platforms, scheduler, random })` using **fake platform
  adapters** that implement `PlatformAdapter` (they may attach anything to a `PlatformError`, like
  the real Google and Twilio adapters do) and **one fake `Scheduler`** that the server and the
  browser code under test (`createConnectivityMonitor`, `createDashboardClient`) both receive.
  Everything timed must use the scheduler it is given;
- call `app.probes.probe`, `app.runner.start` and `app.close()`, and read the `Store` they passed
  in through its existing methods;
- connect real WebSocket clients to `app.listen(0)`, wire them to `createDashboardClient`, and
  render components with `vendor/preact/render-to-string.mjs`;
- run the real server, `src/server/main.ts`, with `PORT=0` and `SEED_PATH`, and send it hostile
  requests and frames. They find its address in the `listening on http://127.0.0.1:<port>` line
  it prints: keep that line.

Run your tests with `npm test`. Write what you found, why it happened and what you changed in
`NOTES.md`, including how you used AI assistance and what you checked yourself.
