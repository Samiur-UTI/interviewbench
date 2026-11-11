# Relay campaign console

Relay is a SaaS console for outbound marketing. Agencies and growth teams connect their customers'
ad and messaging accounts once and run campaigns from one place. The console is the screen they
keep open all day: one card per connection with its live status, and every campaign run with its
progress and activity.

- A **connection** is a customer's credential for one platform (Google Ads, Meta, Twilio,
  LinkedIn). Agencies have dozens.
- A **campaign** targets one platform through one connection.
- A **run** executes a campaign: it sends one **item** per target (an ad, an ad-set update, an
  SMS, a connection request) and records an **event** for what happened.

Runs are started and paused by operators from the ops tool; the console shows them. A run paused
by an operator has `pausedReason: "user"`. A run whose credential the platform rejects is paused by
the console itself (`pausedReason: "unauthorized"`) and resumes when the user reconnects that
connection from the dashboard (see "Reconnecting").

## Platforms

| Platform | Method | Adapter | Notes |
|---|---|---|---|
| `google` (Google Ads) | `oauth` | `src/server/platforms/google.ts` | `docs/platforms/google.md` |
| `meta` (Meta Marketing) | `oauth` | `src/server/platforms/meta.ts` | `docs/platforms/meta.md` |
| `twilio` | `api_key` | `src/server/platforms/twilio.ts` | `docs/platforms/twilio.md` |
| `linkedin` | `session` | `src/server/platforms/linkedin.ts` | `docs/platforms/linkedin.md` |

Every platform authenticates differently, expires differently and limits us differently. The notes
in `docs/platforms/` are where the team writes down what each one does; read them before touching
an integration. Adapters implement `PlatformAdapter` (`src/server/platforms/types.ts`) and report
failures as `PlatformError` with a `cause`: `unauthorized` (the credential was rejected),
`unreachable` (network, timeout, 5xx) or `rate_limited` (throttled).

`npm start` runs against simulated platforms (`src/server/platforms/sandbox.ts`) unless
`RELAY_PLATFORMS=live`.

## Code layout

| Path | What |
|---|---|
| `src/shared/` | Types, config, the WebSocket protocol and the `Scheduler` (shared by server and browser) |
| `src/server/app.ts` | `createApp`: wires everything; one scheduler drives every timer |
| `src/server/store.ts` | In-memory store (Postgres in production, same interface) |
| `src/server/tokens.ts` | `TokenCache`: credentials for platform calls, OAuth refreshes |
| `src/server/retry.ts`, `breaker.ts` | Backoff with full jitter; one circuit breaker per connection |
| `src/server/connectivity.ts` | `ProbeService`: health checks ("probes") of a connection |
| `src/server/runner.ts` | `CampaignRunner`: executes runs |
| `src/server/ws.ts` | A small RFC 6455 WebSocket server and the `Hub` that speaks our protocol |
| `src/server/http.ts`, `views.ts`, `pages/` | Routes, what the browser may see of each record, the server-side render |
| `src/client/` | The dashboard: Preact + htm components, the state reducer, the connectivity monitor, `main.ts` (browser entry) |
| `vendor/preact/` | Preact, htm and preact-render-to-string, checked in (see its README) |
| `data/seed.json` | Demo data for `npm start` |

The dashboard (`/` or `/dashboard`) is rendered on the server with the same components the browser
uses, with the state embedded in the page; `src/client/main.ts` hydrates it and opens the
WebSocket. Everything in `src/client/` except `main.ts` also runs in Node (tests and the server
render), so it must not touch `window` or `document` when imported.

## How a run works

`CampaignRunner.start(runId)` sends the run's items in order, from `progress.nextIndex`:

1. Each item is sent through the connection's adapter with `withRetry` (`config.retry`):
   `unreachable` and `rate_limited` are retried with exponential backoff and full jitter.
   `unauthorized` on an `oauth` connection triggers one forced token refresh and one more attempt.
2. An item counts as sent only after the adapter resolved. Then `progress.nextIndex` moves past it
   (it is always the first unsent item) and a `sent` event is recorded.
3. Platform calls on a connection go through its circuit breaker (`config.breaker`). Exhausted
   transient retries or an open circuit do not fail the run: the runner waits (until the circuit
   lets calls through again, `breaker.openMs` at most) and tries the same item again. The breaker
   is the failsafe that stops us hammering a platform that is down.
4. A credential the platform still rejects after the forced refresh (or at once, for methods that
   can't refresh) pauses the run: `status: "paused"`, `pausedReason: "unauthorized"`, with a
   `paused` event. `progress.nextIndex` stays on the item that was rejected (it was not sent).
5. `CampaignRunner.resume(runId)` continues a paused run from `progress.nextIndex`: it marks the run
   `running`, records a `resumed` event and sends the rest in the background. Nothing already sent
   is sent again; the rejected item is the first one sent.
6. A run whose status is changed from outside (an operator pausing it) stops before its next item.
   After the last item the run is `completed`.

## Connectivity

The connection cards are what users look at to decide whether something needs their attention.

- The server runs probes on a schedule (`connectivity.probeIntervalMs`, 60 s) and pushes every
  result to the dashboards as `probe` messages. A dashboard can ask for an immediate check
  (`{ type: "probe", connectionId }`); the server answers it with exactly one platform call and
  pushes the result. The server keeps no per-viewer UI state and does no confirmation of its own:
  **the browser's monitor decides what the card shows** (status is per viewer; a viewer that just
  loaded the page must not inherit another viewer's half-finished confirmation).
- What a card shows (`ConnectionStatus`): `connected`, `checking`, `disconnected` (with a
  Reconnect button), `paused` (platform unavailable, resumes by itself).

Rules the monitor follows (`src/client/connectivity.ts`):

1. **Reconnect is only for a dead credential.** `disconnected` is shown only after
   `connectivity.confirmAttempts` consecutive `unauthorized` results, each confirmed by a check
   the monitor requests `connectivity.confirmIntervalMs` after the previous result arrived. Until
   then the card shows `checking`. A single `unauthorized` proves nothing (a refresh in flight
   fails one probe).
2. **A platform that can't be reached is not a dead credential.** `unreachable` and
   `rate_limited` never lead to Reconnect: the card shows `checking` and the monitor keeps
   requesting checks at `confirmIntervalMs` until a result is ok or the circuit opens. Probes count
   toward the breaker like any other platform call, so a real outage ends in `paused`.
3. **A tripped circuit is not a broken credential.** `circuit_open` shows `paused`, never
   Reconnect, and stops the monitor's checks for that connection until the next pushed result.
4. On page load (`snapshot`), a connection with no `lastProbe` or an ok one is `connected`; a
   `circuit_open` one is `paused`; a failed one is `checking` and counts as the first result of a
   confirmation (an `unauthorized` snapshot result is strike one).
5. The campaign is the ground truth: if it is sending, the check must agree with it.

## Reconnecting

When a card shows Disconnected, its Reconnect button opens a form for the connection's method
(`ReconnectForm`): the user pastes what the platform's own flow gave them (docs/platforms/,
"Reconnecting"). The form never shows a secret; it prefills the public identifiers (the Twilio
account SID read-only, because a different account is a new connection).

The server (`POST /api/connections/:id/credentials`, docs/protocol.md) validates the body for the
method, stores the new credential, drops the cached token and the connection's circuit, checks it
once and pushes the result. If the check passes, every run on that connection paused for a rejected
credential resumes. Runs an operator paused stay paused, and nothing resumes on a credential whose
check failed.

## Rules

1. **Never make users reconnect for nothing.** Reconnecting rotates the credential and drops cached
   tokens; for LinkedIn a re-login can get the customer's account restricted. Hence the
   connectivity rules above.
2. **Secrets never reach the browser.** Access and refresh tokens, API key secrets, session
   cookies: not in the page, not in any API response, not in WebSocket messages, not in run events
   or error details, not in error messages. Public identifiers (account SID, API key SID, scope,
   token expiry, profile URL, user agent) may be shown, and the reconnect form needs some of them.
3. **Everything the platforms give us is untrusted** (lead names, headlines, error bodies), and so
   is everything a browser sends us. Platform text is shown as text, never as markup, and never
   dropped. No message a browser can send may take the console down.
4. **A paused run resumes where it stopped** and never sends an item twice.
5. **Our own health checks must not eat the platforms' quotas or lose events.**

When they conflict: secrets and server availability, then never-reconnect-for-nothing, then
resume-without-duplicates, then honest live status, then quota and bandwidth.

## Protocol

`docs/protocol.md` has the details. In short:

- HTTP: `GET /` and `/dashboard` (the page), `GET /api/dashboard` (`DashboardState`),
  `GET /api/connections/:id`, `POST /api/connections/:id/probe` (`ProbeResult`),
  `POST /api/connections/:id/credentials` (reconnect), and the
  browser's modules under `/vendor/`, `/src/client/` and `/src/shared/` (TypeScript served with
  its types stripped).
- WebSocket `/ws`: the server sends `snapshot`, then `probe`, `run`, `event` and `connection`
  messages; the
  browser sends `{ type: "probe", connectionId }` and `{ type: "snapshot" }`. Types:
  `src/shared/protocol.ts`.

## TypeScript in this repo

The code runs directly on Node.js 24 (built-in type stripping), and the browser gets the same files
with their types stripped by the server: there is no build step. That means:

- Only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties.
- Relative imports carry the `.ts` extension (`import { reduce } from "./dashboard-state.ts"`).
- Use `import type { ... }` for type-only imports. A plain `import { Run }` of an interface fails
  at runtime with a SyntaxError.
- No npm dependencies. The server uses what Node.js ships with; the browser libraries are the ones
  in `vendor/preact/`.

## Commands

```bash
npm start            # http://127.0.0.1:3000 with data/seed.json and the sandbox platforms
npm test             # node --test over tests/**/*.test.ts
npm run typecheck    # optional: tsc --noEmit (TypeScript is installed in the task image)
```

`npm start` reads `PORT` (0 picks a free port), `SEED_PATH` (a JSON file shaped like
`data/seed.json`), `RELAY_PLATFORMS=live` (the real integrations; they need the credentials listed
in `src/server/platforms/index.ts`), and for the sandbox `RELAY_SANDBOX_LATENCY_MS` ("min,max")
and `RELAY_SANDBOX_FAILURE_RATE` (0 to 1).

Requires Node.js 24.11 or later.
