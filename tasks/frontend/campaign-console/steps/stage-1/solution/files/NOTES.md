# Notes

## Stage 1: what was wrong, why, and how I fixed it

### Ticket A: phantom disconnects

Two independent causes; each explains part of the ticket, and both had to go.

**1. The browser's monitor didn't follow README's Connectivity rules** (`src/client/connectivity.ts`).
It showed `disconnected` on the first `ok: false`, whatever the cause, so a single slow Meta or
Twilio answer flipped the card to Reconnect; `circuit_open` (we didn't even call the platform)
was treated the same way; and the follow-up check was scheduled with `probeIntervalMs` (60 s),
so the card stayed on Disconnected until the next result came in (another dashboard's check,
the next run update, or the 60 s round), even when the platform was back in seconds. That is the
Meta/Twilio part of the ticket.

Rewritten as a small per-connection state machine (`status`, `strikes`, at most one pending
confirm timer):

- ok: `connected`, strikes reset, timer cancelled.
- `circuit_open`: `paused`, strikes reset, timer cancelled, no checks until the next pushed result.
- `unauthorized`: strike; at `confirmAttempts` strikes `disconnected`, otherwise `checking` and one
  check requested `confirmIntervalMs` **after this result arrived** (a slow answer pushes the next
  check back; a check is never requested while one is pending).
- `unreachable` / `rate_limited`: `checking` and keep checking every `confirmIntervalMs`, without a
  strike. A real outage ends in `paused` because probes count toward the circuit breaker.
- While `disconnected`, failures change nothing and request nothing; the server's schedule brings
  the next result, and a success (or an open circuit) leaves.
- Page load: a failed `lastProbe` in the snapshot is the first result of a confirmation. Later
  snapshots (the client re-requests one after every run change) only apply results newer than the
  last one applied, so a resync can't count the same strike twice or restart a confirmation.

**2. Health checks sent an expired Google token** (`src/server/connectivity.ts`). `ProbeService`
built the credential with `tokens.peek(id) ?? connection.credential`. `peek` returns whatever was
cached, with no expiry check (its doc comment says so), and the stored credential is just as old.
Campaigns go through `tokens.getFresh`, which refreshes within `refreshMarginMs` of `expiresAt` and
shares one refresh between concurrent callers. Google access tokens live 3600 s
(`docs/platforms/google.md`), so an hour after the last refresh every Google check sent a dead
token, got a 401, and reported `unauthorized`, while the campaign, refreshing on its own path,
kept sending. Three such results in a row are a "confirmed" dead credential, which is why only
the Google card stuck at Disconnected until someone reconnected. Meta tokens last 60 days and
Twilio/LinkedIn credentials don't expire, so they never hit this. The monitor fix alone doesn't
help Google: three honest `unauthorized` answers are a dead credential as far as the browser can
tell. The checks have to send the token a campaign would send.

Fix: the probe calls `tokens.getFresh(id)` inside the breaker call, so it gets the same refresh
(and the same de-duplication: a probe and a send racing on an expired token cause one refresh,
which matters because Google rate-limits refresh bursts). A refresh that fails is reported with
its cause (`unauthorized` for a dead refresh token is a real dead credential). An unknown id now
rejects `NotFoundError` before anything else.

Why LinkedIn customers got challenged: every false Disconnected invited a Reconnect, which for
LinkedIn is a fresh login in the customer's browser plus a new session on our side; a few of
those in a day is exactly what `docs/platforms/linkedin.md` says triggers a challenge. Fixing the
false Disconnected fixes that; the monitor's confirm checks for LinkedIn are three cheap
`HEAD /feed/` calls 2 s apart, only after a failure.

### Ticket B: the pentest finding

What the browser receives is built in `src/server/views.ts` (page state, `/api/*`, WebSocket
messages), so that is where the boundary belongs. The leaks:

- `toPublicConnection` spread the whole `Connection` (credential included) and cast it, so the
  page, `/api/dashboard`, `/api/connections/:id` and every WebSocket snapshot carried access and
  refresh tokens, the Twilio API key secret and the LinkedIn cookies.
- `toPublicEvent` spread the event, `detail` included: the adapters put the failed request,
  with its `authorization` header, in `PlatformError.details` for support, and the runner stored
  that as `detail`. The seed already has a LinkedIn retry event with both cookies in it.
- Event **messages** quoted `error.message`, and the Google and Twilio adapters name the rejected
  token or key in their messages. Worse, the quoted token is often one that was just rotated by a
  forced refresh, so redacting "the connection's current secrets" would miss it.

Fixes:

- Views are now an allow-list, built field by field: `PublicConnection` with `public` per method
  exactly as `PublicCredential` types it (oauth: scope, expiresAt; api_key: accountSid,
  apiKeySid; session: userAgent, profileUrl), `lastProbe` field by field, runs without items,
  events without `detail`, campaigns field by field. A new field on a stored record stays on the
  server until someone adds it here on purpose.
- The runner writes event messages in our own words, from the failure's cause and the target
  ("Attempt 1 for Ana failed (credential rejected); retrying in 250 ms", "Google Ads rejected the
  connection's credential; Ana was not sent"). The adapter's message and details are kept in the
  event's `detail` for support, server-side only. I chose this over redacting known secret values
  because redaction can only remove what it knows about: rotated tokens, encoded forms (Twilio's
  basic auth is base64 of `sid:secret`) and whatever a future adapter attaches would all slip
  through.
- The page embeds the state with `<`, `>`, `&`, U+2028 and U+2029 escaped as `\uXXXX` inside the
  JSON (`serializeForScript`). A browser ends a script element at the first `</script`, so a lead
  named `</script><script>...` closed the state element and ran its own script; `<!--` can also
  change where the element ends. The escapes only occur inside JSON strings, so
  `JSON.parse(textContent)` gives back the same state and `main.ts` is unchanged.
- `RunList` rendered `target.headline` with `dangerouslySetInnerHTML` ("keep LinkedIn's <em>
  highlighting"), which README rule 3 forbids; it is now a text child, so `<em>` shows as the
  characters `<em>` and nothing is dropped.

Availability (README rule 3, "no message a browser can send may take the console down"), four
separate crash paths:

- `Hub.receive` did `JSON.parse` with no try/catch inside the socket's `'data'` handler: an
  uncaught exception ends the process. Client messages are now validated by
  `parseClientMessage` (a JSON object with a known `type` and the right fields); anything else gets
  `{ type: "error", code: "bad_message" }`, and the socket stays open.
- A `probe` for an unknown id crashed in an async function nobody awaited (`void`), so the
  rejection was unhandled and Node exits. The hub now answers `{ type: "error", code: "not_found" }`
  and catches anything else from the probe.
- `POST /api/connections/:id/probe` had the same unknown-id crash, and no request handler had a
  catch (Node's http server doesn't handle a rejected handler). Unknown ids answer 404
  `{ error: "not_found" }`, and every request goes through a wrapper: `NotFoundError` is a 404,
  anything else is logged and answered 500 `{ error: "internal" }`.
- `decodeFrame` correctly throws `FrameError` for frames a client must not send (unmasked,
  fragmented, oversized, reserved bits), but it was called inside the `'data'` handler with no
  catch. The connection now closes itself with the frame's close code (1002/1009) and ignores
  anything else that peer sends; any other exception from a message handler closes that one
  socket with 1011. The 1 MiB limit is unchanged.

### What I didn't change (and why)

- The server still keeps no confirmation state and answers each probe request with exactly one
  platform call, pushed to every dashboard: confirmation is per viewer.
- The dashboard client still re-requests a snapshot after every `run` message. It costs bandwidth
  with long campaigns, but it is outside these tickets.
- The `Content-Security-Policy` the pentester mentions would be defence in depth; I'd add one, but
  the console loads its modules from the same origin without a build step, so it needs a decision
  on `script-src` and the inline JSON state (fine: `application/json` doesn't execute). I fixed the
  sinks themselves, which is what the report's outcomes require.
- Old events in production may still have a token in `message` (written by the old wording).
  New events can't; the old rows need a one-off migration, which I'd raise with the team rather
  than hide in the views.

### Tests added

- `tests/connectivity.test.ts`: the confirmation timeline (including a slow answer), success
  resetting strikes, transient failures never disconnecting, `circuit_open`, leaving Disconnected,
  page-load strike one, resync snapshots not double-counting, `stop()`.
- `tests/probe.test.ts`: an expired stored token is refreshed before the check (and only once);
  unknown id rejects `NotFoundError`.
- `tests/security.test.ts`: no secret in the state or the page (stored event details included);
  per-method `public`; a token quoted by an adapter (and then rotated) never reaches events while
  support keeps it in `detail`; the state script survives `</SCRIPT>`, `<!--` and U+2028; headlines
  as text; client-message validation; an unmasked frame closes the connection with 1002 instead
  of throwing.

## Stage 2: reconnect and resume (design and trade-offs)

## Stage 3: many open dashboards (what cost what, what I changed, what it costs)

## How I used AI assistance (and what I checked myself)

I used an assistant to read the code base alongside me and to draft tests. Its first suggestion
for Ticket A was to make the server confirm failures (probe three times before reporting), which
contradicts README ("the server keeps no confirmation state; the browser's monitor decides") and
would triple platform calls; and it initially proposed fixing the leak by deleting
`accessToken`/`refreshToken` from connections, which misses the Twilio secret, the LinkedIn cookies
and the tokens in event messages and details. I checked each secret field against
`docs/platforms/*.md` and the `Credential` union myself, ran the hostile-name page through
`JSON.parse` the way a browser delimits the script, and reproduced every crash path against
`npm start` before and after the fix.
