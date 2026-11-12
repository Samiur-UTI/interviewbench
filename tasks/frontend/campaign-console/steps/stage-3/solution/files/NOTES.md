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
Twilio/Linkfolio credentials don't expire, so they never hit this. The monitor fix alone doesn't
help Google: three honest `unauthorized` answers are a dead credential as far as the browser can
tell. The checks have to send the token a campaign would send.

Fix: the probe calls `tokens.getFresh(id)` inside the breaker call, so it gets the same refresh
(and the same de-duplication: a probe and a send racing on an expired token cause one refresh,
which matters because Google rate-limits refresh bursts). A refresh that fails is reported with
its cause (`unauthorized` for a dead refresh token is a real dead credential). An unknown id now
rejects `NotFoundError` before anything else.

Why Linkfolio customers got challenged: every false Disconnected invited a Reconnect, which for
Linkfolio is a fresh login in the customer's browser plus a new session on our side; a few of
those in a day is exactly what `docs/platforms/linkfolio.md` says triggers a challenge. Fixing the
false Disconnected fixes that; the monitor's confirm checks for Linkfolio are three cheap
`HEAD /feed/` calls 2 s apart, only after a failure.

### Ticket B: the pentest finding

What the browser receives is built in `src/server/views.ts` (page state, `/api/*`, WebSocket
messages), so that is where the boundary belongs. The leaks:

- `toPublicConnection` spread the whole `Connection` (credential included) and cast it, so the
  page, `/api/dashboard`, `/api/connections/:id` and every WebSocket snapshot carried access and
  refresh tokens, the Twilio API key secret and the Linkfolio cookies.
- `toPublicEvent` spread the event, `detail` included: the adapters put the failed request,
  with its `authorization` header, in `PlatformError.details` for support, and the runner stored
  that as `detail`. The seed already has a Linkfolio retry event with both cookies in it.
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
- `RunList` rendered `target.headline` with `dangerouslySetInnerHTML` ("keep Linkfolio's <em>
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

### Pausing instead of failing

`CampaignRunner` used to mark a run `failed` when the platform still rejected the credential after
the forced refresh, which threw the checkpoint away. Now it sets `status: "paused"`,
`pausedReason: "unauthorized"` and records a `paused` event in our own words (stage 1's rule: the
adapter's message, which names the rejected key, stays in `detail`). `progress.nextIndex` already
pointed at the first unsent item and the rejected item was never counted, so the checkpoint needed
no change: an item counts as sent only after the adapter resolved.

`resume(runId)` marks the run `running`, clears `pausedReason`, records `resumed` and resolves; the
items go out in the background, as with `start`. The send loop is started through `launch`, which
first waits for a loop that is still winding down for the same run. Without that, a resume that
lands right after a pause (or right after an operator paused a run mid-send) would find the old
loop's promise still registered: `start` would hand it back and nothing would run, or two loops
could send for one run. `resume` itself doesn't decide which runs deserve it; the reconnect does.

### The endpoint

`POST /api/connections/:id/credentials` lives in `reconnect.ts` (orchestration) and
`credentials.ts` (validation, per method). The rules come from `docs/platforms/*.md`,
"Reconnecting", and they disagree with the obvious implementation in four places:

- `expires_in` is **seconds**; every clock here is a ms epoch. `now + expiresIn` would store a token
  that "expires" at once, so every call refreshes it (and Google rate-limits refresh bursts).
- Google re-issues a refresh token only on a new consent. A reconnect without one keeps ours;
  dropping it would make the next refresh fail an hour later and pause the runs again. Meta has no
  refresh tokens at all, so I never store one there, even if a client sends one.
- Twilio's account SID is the connection (numbers, opt-outs, history). A different SID is
  `invalid_credential` on `accountSid`, not a silent re-point; a new key pair is normal.
- Linkfolio's profile URL stays. The new credential is built field by field from the method's
  fields, so `profileUrl` (or anything else) in the body can't overwrite what is stored.

Validation runs before any effect, field by field in the documented order, so the form can point
at the field to fix. Then, in order: store, `tokens.invalidate`, `breakers.reset`, one probe through
the hub (stored, pushed as `probe`), push `connection`, and only if the probe passed, resume the
connection's runs paused with `"unauthorized"`. The two easy-to-miss steps:

- Without `tokens.invalidate`, `getFresh` keeps returning the cached credential (the token the
  platform just rejected, or the one the forced refresh produced), so the check fails and, if
  something resumed anyway, the run would pause again on its first send.
- Without `breakers.reset`, a connection whose circuit opened during the outage answers the check
  with `circuit_open` without calling the platform, so a perfectly good new key resumes nothing.

Operator-paused runs (`"user"`) are the operator's to lift; other connections' runs wait for their
own reconnect. Reconnects of one connection are serialised, so a double submit can't interleave
two credential swaps or resume a run twice (`resume` also rejects a run that isn't paused).

The body reader caps bodies at 64 KiB (413) and answers `invalid_json` for anything that isn't a
JSON object, so a browser can't make the server buffer without limit or throw.

### The dashboard

- `ConnectionCard`: the Reconnect button is described by the status text (`aria-describedby`) and
  toggles the form (`aria-expanded`/`aria-controls`). Cancel and Escape close it and put focus back
  on the button; a successful reconnect moves focus to the status line, which now says Connected.
  If another viewer reconnects first, the card leaves Disconnected and the form closes.
- `ReconnectForm`: fields per method, in the server's order, each named as the server names it in
  errors (`cookies.lf_session`...), so a 400 marks exactly that input (`aria-invalid`, its message
  linked with `aria-describedby`). Secrets are password inputs and never prefilled; public
  identifiers are prefilled; the account SID is read-only. The inputs are uncontrolled: a re-render
  while the request is in flight (the submit button is disabled then) keeps what was typed. Meta's
  form has no refresh-token field; Google's is optional and says that empty keeps the current one.
- `createDashboardClient.reconnect` applies the answer's `connection` and `probe` as if they had
  been pushed, so a passing check shows Connected at once. The same facts also arrive over the
  socket; applying them twice changes nothing, since the form is only offered on a Disconnected
  card, where a repeated failure is a no-op and a repeated success is still Connected.
- The `role="status"` live region names the newest pause or resume ("Resumed: Spring SMS"). I
  derive it from the events rather than from the transition the reducer sees: the client still
  replaces its state with a snapshot after every `run` message (stage 1 left that alone), and a
  page rendered on the server must say the same. It is visually hidden; the run list shows the
  status.

### Known gaps

- If the check after a reconnect fails for a transient reason (`unreachable`, `rate_limited`), the
  credential is stored but nothing resumes, and the user has to submit again. Resuming on the next
  passing scheduled check would be friendlier, but it would mean a probe result can start sending
  campaigns, which I'd rather agree with the team first.
- Runs already marked `failed` by the old behaviour are not resumable; they would need a one-off
  migration to `paused` if we want them back.

### Tests added

- `tests/reconnect.test.ts`: pause at the checkpoint and resume without duplicates; validation order
  per method and invalid JSON; seconds vs ms; the Google refresh token kept, Meta's never stored;
  Twilio account and Linkfolio profile kept, extra fields dropped; cache and circuit reset; only the
  right runs resume; nothing resumes on a failed check.
- `tests/reconnect-ui.test.ts`: the form per platform (labels, password fields, read-only account
  SID, Meta without a refresh token), field errors and the disabled submit, the Reconnect button's
  description, the client's reconnect (field error; Connected from the answer), the reducer's
  `connection` message and the live region surviving a snapshot.
- `tests/security.test.ts`: the rotated-token test now expects a pause instead of a failure.

## Stage 3: many open dashboards (what cost what, what I changed, what it costs)

### Measured before and after

Same harness both times: `createApp` with counting fake adapters on a fake clock, the four seeded
connections, real WebSocket dashboards driven by `createDashboardClient`.

| | before | after |
|---|---|---|
| platform checks when the server starts | 0 | 4 (one per connection) |
| checks caused by opening 1 / 5 / 20 dashboards | 4 / 20 / 80 | 0 / 0 / 0 |
| checks per connection per interval, 1 / 5 / 20 dashboards | 1 / 5 / 20 | 1 / 1 / 1 |
| 20 dashboards ask to check one connection at the same moment | 20 calls | 1 call, 1 result to all |
| snapshot with a 5,000-event run in the store | 659,158 B | 5,160 B |
| `GET /api/dashboard`, same store | 659,130 B | 5,124 B |
| the page, same store | 1,402,271 B | 12,603 B |
| one dashboard while a 100-item campaign sends (same store) | 315 messages, 101 of them snapshots, 68.0 MB | 214 messages, 0 snapshots, 44 KB |

For the agency in the ticket (42 connections, ~30 screens) that is 30 × 60 = 1,800 `debug_token`
calls per hour per Meta token before (the budget is ~200), and 60 after, whatever the number of
screens; opening the dashboard on 30 screens no longer fires 30 × 42 checks.

### Where it came from

- **Checks per viewer.** The hub ran one probe loop per socket: on connect it checked every
  connection once (one after another) before sending the snapshot, then every
  `probeIntervalMs` it checked every connection again for that socket and sent the results to it
  alone. Checks scaled with the number of screens, and every page load was a burst. The results
  are facts about the connection, not about the viewer (README, "Connectivity"), so one schedule
  serves everyone.
- **Lost events on connect.** That same welcome built the snapshot state first, then awaited the
  checks, and only then registered the socket for broadcasts. Anything that happened while the
  checks were in flight (an event, a run update) was neither in the snapshot nor sent to the
  socket. That is "the counter is one behind after a reload". It mostly healed because...
- **...the client re-requested a full snapshot after every `run` message**, so the next run update
  repaired the state (and a run that had just finished never got one: those tickets). Each
  re-request was a full snapshot, and a snapshot carried every event of every run: with one
  5,000-event run in the account, 659 KB per sent item per screen.

### What I changed

**One schedule (`Hub`, `src/server/ws.ts`).** `app.listen()` starts it: a round at once (so a
dashboard that connects finds results), then one every `probeIntervalMs` on the app's scheduler.
Each round books the next one *before* starting its checks, so a hanging platform can't push the
schedule back or hold up the other connections. `close()` stops it and the app's timer tracking
clears whatever is left; results that land after close are dropped.

**Joined checks.** `hub.requestProbe(id)` keeps one in-flight promise per connection: the round,
a dashboard's request, `POST .../probe` all share it, the platform is called once, and the one
result is stored and broadcast once. A request when nothing is in flight still calls the platform
at once, so the monitor's confirmations (2 s apart, one call each) are exactly what they were;
answering from the stored `lastProbe` or waiting for the next round would have turned "confirm"
into "repeat the last answer". The reconnect asks for `{ fresh: true }`: its check must be made
with the credential just stored, not join one that started with the old key; the older check's
result, when it lands, is not broadcast (it is about a credential that no longer exists).

**Ordering (`seq`).** Every broadcast gets the next number of one server-wide counter. On
connect, registering the socket and sending its snapshot happen in the same synchronous step, and
the snapshot carries the counter's current value: every change is either in it (seq at or below)
or a broadcast it receives after it. `JSON.stringify` per broadcast is done once, not per socket.
Errors are replies to one socket, so they carry no `seq` (numbering them would make a gap for
everyone else). Probe results are stored and broadcast in the same microtask drain, so a snapshot
can't contain a result whose broadcast it then also receives.

**The client (`dashboard-client.ts`, `dashboard-state.ts`).** No re-requests. It tracks the last
`seq` applied; an older or repeated one is ignored; one more than one above the last means a
broadcast never arrived, and it asks for one snapshot (not again until it has come). A snapshot
resets the counter (a restarted server starts again from 1). A snapshot replaces the state but
keeps a run's older events the client already holds when they join up with the snapshot's
without a hole, so a resync doesn't take away what the user loaded. An `event` adds one to its
run's `eventCount` (the server's `run` messages carry the authoritative number).

**Recent events (`views.ts`, `store.ts`, `http.ts`).** `toDashboardState` takes
`{ recentEvents }` (the hub and the routes pass `config.dashboard.recentEvents` from the config
the app was created with) and `PublicRun.eventCount` is the total. The store got
`listEvents(runId, { before, limit })` (binary search on the ascending ids, then a slice) and
`countEvents`, so neither a snapshot nor a page of 50 copies 5,000 events.
`GET /api/runs/:id/events` validates `before` and `limit` as decimal positive integers (limit ≤
200, default 50) and returns `nextBefore` = the oldest id returned, or `null` when nothing older
exists. `loadEarlierEvents(runId)` asks for the page before the oldest held event and merges by
id (a double click shares one request), and `RunList` shows "Showing the latest N of M events"
with a "Load earlier events" button (`aria-controls` the list, described by the count).

### What it costs, and what I left

- A dashboard now sees a check result up to one interval old on load (the stored `lastProbe`)
  instead of a fresh one. README's priorities put quota above that, and the monitor already
  treats a failed stored result as strike one and confirms it 2 s later.
- With no dashboard open the server still checks every connection every minute. That is the
  schedule README describes, and it keeps `lastProbe` fresh for the next page load; per-tenant
  "nobody is watching" pausing would be the next step if quotas need it.
- The live region is derived from the events the dashboard holds: a page loaded after a run's
  resume has scrolled out of the newest 20 has nothing to announce (the badge still says
  Running). A fresh page shouldn't announce old news anyway.
- A dashboard keeps every event it saw live; one left open for days on a busy run grows. A cap
  per run (drop the oldest beyond a few hundred, offer "Load earlier events" again) is easy to
  add; I didn't, to keep "nothing a user was reading disappears" simple to reason about.
- A superseded check (the reconnect case) still writes its `lastProbe` when it lands. It is
  stored but not pushed; if it lands after the fresh one, the stored value is the stale one until
  the next round. Fixing that properly means versioning credentials in the store, which I'd
  raise rather than hide.

### Tests added

- `tests/live-updates.test.ts`: the schedule (a round at listen, one per interval with 5
  dashboards, no check on connect), joined checks (requests from two dashboards and a round, one
  call, one result each), `seq` server-wide with the snapshot cut exactly at its `seq` while
  events keep coming, `close()` with a check in flight.
- `tests/recent-events.test.ts`: store ranges and counts, the state's newest events and total,
  the app's own `recentEvents`, walking 1,000 events through the API, validation, the client's
  gap handling and snapshot merge, "Load earlier events" (one request per double click, nothing
  once all are held, the button gone).
- Updated `tests/reconnect.test.ts` (counts calls from after the listen-time round) and the
  `PublicRun` fixtures in `tests/dashboard-state.test.ts` and `tests/reconnect-ui.test.ts`
  (`eventCount`).

## How I used AI assistance (and what I checked myself)

I used an assistant to read the code base alongside me and to draft tests. Its first suggestion
for Ticket A was to make the server confirm failures (probe three times before reporting), which
contradicts README ("the server keeps no confirmation state; the browser's monitor decides") and
would triple platform calls; and it initially proposed fixing the leak by deleting
`accessToken`/`refreshToken` from connections, which misses the Twilio secret, the Linkfolio cookies
and the tokens in event messages and details. I checked each secret field against
`docs/platforms/*.md` and the `Credential` union myself, ran the hostile-name page through
`JSON.parse` the way a browser delimits the script, and reproduced every crash path against
`npm start` before and after the fix.

Stage 2: the assistant drafted the endpoint as `{ ...stored, ...body }` with `expiresAt = now +
expiresIn` and a resume of every paused run on the connection. Each of those breaks a documented
rule (the profile URL and the method could be overwritten by the body, seconds stored as ms, an
operator's pause lifted), so I rewrote validation per method from the platform notes and checked
each rule with a test that fails on the naive version. I also had it list what reads the token
cache and the breaker, which is how I found that the check after a reconnect would otherwise go out
with the cached, rejected token or not at all behind an open circuit.

Stage 3: asked for "one probe per interval", the assistant first moved the per-socket loop into a
shared timer and answered dashboard requests from the stored `lastProbe`. That passes a quick
count but turns the monitor's three confirming checks into one platform call and two repeats, so
a dead key could never be confirmed by fresh evidence; I kept requests as real calls and only
join ones that overlap. It also suggested fixing the lost event by keeping the client's snapshot
re-request "for safety", which is the bandwidth problem itself. I reproduced the lost event with a
deferred probe on connect before changing the hub, measured every number in the table above with
the same harness before and after, and checked the walk through 5,000 events for duplicates and
gaps.
