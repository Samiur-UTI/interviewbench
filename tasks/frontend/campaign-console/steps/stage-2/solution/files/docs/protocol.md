# Console protocol: HTTP and WebSocket

What the server (`src/server/http.ts`, `src/server/ws.ts`) and the dashboard
(`src/client/main.ts`, `src/client/dashboard-client.ts`) exchange today. Types are in
`src/shared/types.ts` and `src/shared/protocol.ts`. Every timestamp is a ms epoch.

## HTTP

| Route | Answer |
|---|---|
| `GET /`, `GET /dashboard` | The dashboard page (server-rendered HTML, below) |
| `GET /api/dashboard` | `DashboardState` as JSON |
| `GET /api/connections/:id` | The connection as JSON; 404 `{ "error": "not_found" }` for an unknown id |
| `POST /api/connections/:id/probe` | Checks the connection now (one platform call) and answers the `ProbeResult`. The result is stored as the connection's `lastProbe` and pushed to every open dashboard as a `probe` message. |
| `POST /api/connections/:id/credentials` | Reconnect: replaces the connection's credential (below) |
| `GET /vendor/...`, `GET /src/client/...`, `GET /src/shared/...` | The browser's modules. `.ts` files are served as JavaScript with their types stripped (`node:module` `stripTypeScriptTypes`); `.mjs`, `.js` and `.css` as they are. Anything else, and any path outside those folders, is a 404. |
| anything else | 404 `{ "error": "not_found" }` |

JSON answers have `content-type: application/json; charset=utf-8`.

### `POST /api/connections/:id/credentials`

The body is JSON, shaped by the connection's method (`ReconnectRequest` in `src/shared/types.ts`;
what each platform hands over is in `docs/platforms/`, "Reconnecting"):

| Method | Body | Stored |
|---|---|---|
| `oauth` | `{ accessToken, refreshToken?, expiresIn }`; `expiresIn` in **seconds** (finite, > 0) | `expiresAt = now + expiresIn * 1000` (ms). Google: a `refreshToken` replaces ours, none keeps ours. Meta has no refresh tokens: one sent anyway is ignored. Scope kept. |
| `api_key` | `{ accountSid, apiKeySid, apiKeySecret }` | `accountSid` must be the connection's own (a different account is a new connection); the key pair is replaced |
| `session` | `{ cookies: { li_at, JSESSIONID }, userAgent }` | cookies and user agent replaced; `profileUrl` kept |

Fields a method doesn't have are ignored. Strings must be non-empty.

Answers:

- 404 `{ "error": "not_found" }`: unknown connection (checked first).
- 400 `{ "error": "invalid_json" }`: the body is not JSON, or not a JSON object. 413
  `{ "error": "too_large" }` over 64 KiB.
- 400 `{ "error": "invalid_credential", "field" }`: the first field, in the order of the table
  (`session`: `cookies`, `cookies.li_at`, `cookies.JSESSIONID`, `userAgent`), that is missing, of
  the wrong type or not allowed. Nothing is stored and no platform is called.
- 200 `{ connection: PublicConnection, probe: ProbeResult, resumed: string[] }`, after these
  effects, in order:
  1. the new credential is stored;
  2. the token cache forgets the connection and its circuit breaker is reset (otherwise the cached,
     rejected token is used, or an open circuit hides the new credential);
  3. one check with the new credential (one platform call), stored as `lastProbe` and pushed to
     every dashboard as a `probe` message;
  4. the connection, as stored after the check, is pushed as a `connection` message;
  5. if the check passed, every run **on this connection** with `status: "paused"` and
     `pausedReason: "unauthorized"` is resumed (`CampaignRunner.resume`), each pushed as a `run`
     message. Runs paused by an operator (`"user"`) and other connections' runs are left alone. If
     the check failed, nothing resumes and `resumed` is `[]`; the credential stays stored.

  `connection` is the public connection after the check (its `lastProbe` is `probe`); `resumed`
  lists the runs now running again. Neither carries a secret.

Reconnects of one connection are handled one at a time.

### `DashboardState`

```ts
{
  connections: Record<string, PublicConnection>;  // by connection id
  campaigns: Record<string, Campaign>;
  runs: Record<string, PublicRun>;                // a Run without its items
  events: Record<string, PublicEvent[]>;          // by run id, ascending event id (oldest first)
}
```

Event ids are 1, 2, 3, ... per run. The state carries every event of every run.

### The page

```html
<div id="app"><!-- the Dashboard component, rendered on the server --></div>
<script id="__STATE__" type="application/json">{ ...DashboardState... }</script>
<script type="module" src="/src/client/main.ts"></script>
```

`main.ts` reads the state with `JSON.parse(document.getElementById("__STATE__").textContent)`,
feeds it to the dashboard client as a `snapshot`, hydrates the server-rendered markup with the
same component tree, and opens the WebSocket. If the socket closes it reconnects with backoff
(1 s, doubling, at most 30 s).

## WebSocket `/ws`

Text frames carrying one JSON message each. Clients must mask their frames (RFC 6455); binary
frames are answered with close 1003. Ping is answered with pong. Fragmented messages are not
supported, and the largest message the server accepts is 1 MiB.

### On connect

1. The server checks every connection once, one after the other (one platform call each), so the
   cards start from fresh results.
2. It sends a `snapshot`: the state as of the moment the dashboard connected, with each
   connection's `lastProbe` set to the result of that check.
3. From then on the dashboard receives the broadcasts below, and every
   `connectivity.probeIntervalMs` the server checks every connection again for this dashboard
   and sends it each result as a `probe` message.

### Server to browser (`ServerMessage`)

| Message | When |
|---|---|
| `{ type: "snapshot", state: DashboardState }` | On connect, and in answer to a `snapshot` request |
| `{ type: "probe", result: ProbeResult }` | A check finished: this dashboard's scheduled checks, and every check any dashboard (or `POST .../probe`) asked for |
| `{ type: "run", run: PublicRun }` | A run changed (status, progress), to every dashboard |
| `{ type: "event", runId, event: PublicEvent }` | A run recorded an event, to every dashboard |
| `{ type: "connection", connection: PublicConnection }` | A connection was reconnected: its public identifiers and the check made with the new credential, to every dashboard (after that check's `probe` message) |
| `{ type: "error", code: "bad_message" \| "not_found", message }` | Defined in `src/shared/protocol.ts` for messages the server can't act on |

```ts
interface ProbeResult { connectionId: string; ok: boolean; cause?: "unauthorized" | "unreachable" | "rate_limited" | "circuit_open"; checkedAt: number }
```

`circuit_open` means the platform was not called: the connection's circuit breaker is open.

### Browser to server (`ClientMessage`)

| Message | Effect |
|---|---|
| `{ type: "probe", connectionId }` | Checks that connection now with exactly one platform call, stores the result as its `lastProbe` and pushes it to **every** dashboard (the result is a fact about the connection, not about the viewer who asked) |
| `{ type: "snapshot" }` | The server sends this dashboard a fresh `snapshot` |

Runs: a credential rejected mid-run pauses the run (`run` message with `status: "paused"`,
`pausedReason: "unauthorized"`, and a `paused` event); a reconnect resumes it (`run` with
`status: "running"`, and a `resumed` event).

The dashboard client (`createDashboardClient`) sends `probe` requests from the connectivity
monitor (README, "Connectivity") and a `snapshot` request after each `run` message, so a run's
counters and its activity list are redrawn from the same state. Its `reconnect(connectionId, body)`
posts the credentials and applies the answer's `connection` and `probe` at once, as if they had
been pushed.
