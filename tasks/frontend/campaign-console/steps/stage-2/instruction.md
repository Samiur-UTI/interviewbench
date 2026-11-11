# Reconnect without losing the run

Support's top complaint since last week's fixes: when a customer deletes the Twilio key we use, or
revokes our Google access, the campaign on that connection is marked **failed** and its progress is
lost. Users restart the campaign, and every target the run had already reached is contacted a
second time. Reconnecting doesn't help either: the Reconnect button sends users off to the
onboarding app, and the failed run stays failed.

Product's decision: a rejected credential **pauses** the run where it stopped; the user reconnects
from the card on the dashboard; the run **resumes** where it stopped, and nothing is sent twice
(README rule 4). Build it, in the server and in the dashboard.

## What must hold afterwards

### Runs pause, and resume

- When the platform still rejects a run's credential after the retry policy (README, "How a run
  works": one forced refresh on `oauth` connections), the run becomes `status: "paused"`,
  `pausedReason: "unauthorized"`. Its `progress` is kept: `nextIndex` stays on the item that was
  rejected (it was not sent). It records a `paused` event, and no `failed` event.
- `app.runner.resume(runId): Promise<void>` resolves as soon as the run is `running` again (no
  `pausedReason`) and its `resumed` event is recorded, not when the run ends: the remaining items
  are then sent in the background, from `progress.nextIndex`. It rejects with `ValidationError` for
  a run that is not paused and `NotFoundError` for an unknown run.
- Across a pause and a resume, every item is sent exactly once, in order: none twice, none skipped.

### `POST /api/connections/:id/credentials`

The user pastes what the platform's own flow gave them. JSON body, by the connection's method:

| Method | Body |
|---|---|
| `oauth` (Google, Meta) | `{ accessToken: string, refreshToken?: string, expiresIn: number }`, `expiresIn` being the token's lifetime as the platform's token response states it (`expires_in`) |
| `api_key` (Twilio) | `{ accountSid: string, apiKeySid: string, apiKeySecret: string }` |
| `session` (LinkedIn) | `{ cookies: { li_at: string, JSESSIONID: string }, userAgent: string }` |

What each platform hands over on a reconnect, in which units, and what must not change, is in
`docs/platforms/` (each note's "Reconnecting" section, and the rest of the note). The credential you
store must follow those notes, and has exactly the fields of its `Credential` type in
`src/shared/types.ts`. Strings must be non-empty. Fields the body shape above doesn't have are
ignored, never stored.

Answers:

- 404 `{ "error": "not_found" }` for an unknown connection.
- 400 `{ "error": "invalid_json" }` when the body is not JSON, or not a JSON object.
- 400 `{ "error": "invalid_credential", "field": <name> }` for the first field that is missing, of
  the wrong type, or not allowed by the platform's rules, checked in this order: `oauth`
  `accessToken`, `refreshToken`, `expiresIn` (a finite number > 0); `api_key` `accountSid`,
  `apiKeySid`, `apiKeySecret`; `session` `cookies` (an object), `cookies.li_at`,
  `cookies.JSESSIONID`, `userAgent`. Nothing is stored and no platform is called.
- 200 `{ connection: PublicConnection, probe: ProbeResult, resumed: string[] }`, after these
  effects, in this order:
  1. The new credential is stored.
  2. From here on, every platform call for this connection, starting with the check below, uses
     the new credential and reaches the platform, whatever had been cached for the old credential
     or whatever its failures had switched off.
  3. One check of the connection: exactly one platform call. The result is stored as its
     `lastProbe` and pushed to every open dashboard as a `probe` message.
  4. `{ type: "connection", connection }` is pushed to every open dashboard: the public connection
     as stored after the check (add it to `ServerMessage` in `src/shared/protocol.ts`).
  5. Only if the check passed: every run **on this connection** with `status: "paused"` and
     `pausedReason: "unauthorized"` is resumed, and each pushes its `run` message. Runs paused by an
     operator (`pausedReason: "user"`) and runs on other connections stay exactly as they are. If
     the check failed, nothing resumes and `resumed` is `[]`; the new credential stays stored.

  `connection` is the same public connection as in step 4 (its `lastProbe` is `probe`), `probe` is
  that check, `resumed` the ids of the runs that are running again.

Stage 1's rules still hold for all of it: no secret (old, new or rotated) in the answer, any
message or any event, and the body is untrusted input.

### The dashboard

- **`ConnectionCard`**, on a `disconnected` card: the Reconnect button has `aria-describedby`
  pointing at the card's status text. It opens a `ReconnectForm` for that connection in the card,
  instead of leaving for the onboarding app.
- **`ReconnectForm`**, exported from `src/client/index.ts`:
  `ReconnectForm({ connection, error?, pending?, onSubmit?, onCancel? })`. `connection` is a
  `PublicConnection`; `error` is a failed attempt `{ error, field? }` as `reconnect` below reports
  it; `pending` is true while a reconnect is in flight; `onSubmit(body)` gets the request body for
  the connection's method; `onCancel()` closes it. What it renders:
  - a `<form>` with `aria-labelledby` pointing at its visible title;
  - one `<input>` per field of the body, its `name` the field's name as the endpoint reports it
    (`accessToken`, `refreshToken`, `expiresIn`, `accountSid`, `apiKeySid`, `apiKeySecret`,
    `cookies.li_at`, `cookies.JSESSIONID`, `userAgent`). A refresh token field only where the
    platform issues refresh tokens, and optional (not `required`). `expiresIn` is
    `type="number"`, its label names the unit, and it starts at 3600 for Google;
  - every secret field `type="password"` and never prefilled; the public identifiers prefilled from
    `connection.public`: `accountSid` read-only (`docs/platforms/twilio.md` says why), `apiKeySid`
    and `userAgent` editable;
  - every input has an `id` unique on the page (two cards can have their forms open) and a
    `<label for>`;
  - with `error={ error: "invalid_credential", field }`, the input named `field` has
    `aria-invalid="true"` and `aria-describedby` pointing at a visible message; no other input is
    marked invalid;
  - a submit button, disabled while `pending`, and a Cancel button (`type="button"`). Cancel and
    Escape call `onCancel`, and focus goes back to the card's Reconnect button.
- **`createDashboardClient(...).reconnect(connectionId, body)`** posts `body` as JSON to
  `<baseUrl>/api/connections/:id/credentials` with the `fetch` it was given (the global one
  otherwise) and resolves, never rejects: `{ ok: true, resumed, probe }` on a 200, otherwise
  `{ ok: false, error, field? }` with the server's `error` code (`"network"` when no answer
  arrived). On a 200 it applies the answer's `connection` and `probe` at once, as if the server had
  pushed them: a check that passed shows the card `connected` without waiting for anything else.
- **The reducer** handles `connection` (replaces that connection) and `run` (replaces the run).
- **`Dashboard`** renders a `role="status"` live region on every render. Once a run has resumed,
  its text contains "Resumed" and the campaign's name. It is rendered from the state `Dashboard` is
  given (`client.state()`), and says the same after the client takes a fresh `snapshot`.

## How your work is checked

As in stage 1: the hidden tests import `src/index.ts` and `src/client/index.ts` (keep every export,
add `ReconnectForm`), build the server with `createApp` and fake platform adapters on one fake
`Scheduler` shared with the browser code, call the endpoint over real HTTP, read and update
`app.store` through its existing methods, call `app.runner`, `app.probes` and
`app.tokens.invalidate(connectionId)`, connect real WebSocket dashboards, and render
components with `vendor/preact/render-to-string.mjs` (so they read attributes, not focus).

Run your tests with `npm test`. In `NOTES.md`, explain your design and what you rejected, including
how you used AI assistance and what you checked yourself.
