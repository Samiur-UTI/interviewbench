# Thirty open dashboards

Our largest agency customer runs 42 connections through the console and keeps the dashboard open
all day on about 30 screens: account managers' laptops, two wall screens, the night shift. Since
they moved over, three things keep coming back.

- **Meta throttles them.** Ad accounts with no campaign running answer `rate_limited`, and the
  cards go to Checking for minutes at a time. Meta's `debug_token` budget is about 200 calls per
  hour per user token (`docs/platforms/meta.md`). Meta's dashboard for one of their tokens shows
  about 1,800 `debug_token` calls per hour, and nothing but the console's health checks calls it.
  Mornings are the worst: when 30 screens open the dashboard within a few minutes, every
  connection is checked about 30 times in a row.
- **LinkedIn challenged two of their senders again**, the same week, with no reconnect involved.
  LinkedIn reacts to bursts of requests from one session (`docs/platforms/linkedin.md`).
- **The dashboard is heavy and sometimes wrong.** One of their accounts has a run with 5,000
  events. The page is 1.4 MB, and while any campaign sends, each open dashboard downloads about
  650 KB per sent item: a 100-item campaign costs every screen about 68 MB, and 30 screens fill
  the office line. Support also has several "the counter is one behind after a reload" tickets:
  an event that happened while the page was connecting is missing from its run until something
  else on that run changes, and on a run that has just finished it never shows up.

README rule 5 is the one being broken: **our own health checks must not eat the platforms' quotas
or lose events**. Fix it in the server and in the dashboard, without giving up anything stages 1
and 2 built (README's priorities still apply when rules conflict).

## What must hold afterwards

### Health checks: one schedule for the whole console

- The server checks every connection on **one schedule**, however many dashboards are open (none
  included): a first round as soon as `app.listen()` is called (without waiting for the clock),
  then a round every `connectivity.probeIntervalMs` on the app's scheduler, until `app.close()`.
  A round calls each connection's platform at most once; each result is stored as the
  connection's `lastProbe` and pushed as a `probe` message to every open dashboard.
- Rounds start on time even when an earlier check hasn't been answered: a connection whose check
  is still in flight is not called again (the round joins that check), and one platform that hangs
  doesn't hold up the others.
- Opening a dashboard calls no platform: its snapshot carries each connection's stored `lastProbe`.
- A check that is asked for (a dashboard's `{ type: "probe", connectionId }`, or
  `POST /api/connections/:id/probe`) keeps its meaning from stage 1: it calls the platform **at
  once** (not at the next round, and not answered from the stored result), and its result is
  pushed to every dashboard. Requests for a connection whose check is still in flight join it:
  one platform call, and its one result is pushed once to every dashboard and answers every
  request. A reconnect's check is still made with the new credential (stage 2): it must not be
  answered by a check that started with the old one.
- After `app.close()` no platform is called and no timer is left, even if a check was in flight.

### Live updates: numbered, nothing lost, nothing twice

- Every message the server broadcasts (`probe`, `run`, `event`, `connection`) carries `seq`: one
  number sequence for the whole server (the same message has the same `seq` on every dashboard),
  1 for the first broadcast, then one higher for each, with no gaps.
- `snapshot` carries `seq` too: the `seq` of the last broadcast its state reflects (0 when there
  was none). The first message on a new socket is its snapshot. Every broadcast a dashboard
  receives after a snapshot has a higher `seq` than that snapshot, and each change is in exactly
  one of the two: in the snapshot, or in a message after it. The same holds for a snapshot sent in
  answer to `{ type: "snapshot" }`.
- `error` is an answer to one dashboard, not a broadcast: it carries no `seq`.
- The dashboard client (`createDashboardClient(...).handle`) applies `probe`, `run`, `event` and
  `connection` messages in order and **does not ask for snapshots** in normal operation. It sends
  `{ type: "snapshot" }` only when a message's `seq` shows it missed one (more than one above the
  last `seq` it applied), once per gap: not again until that snapshot has arrived. A numbered
  message whose `seq` is not above the last one applied is not applied again. Messages without a
  `seq` (the page's embedded state, an answer you apply yourself) are applied as they come.
- A snapshot replaces the dashboard's state, except that a run's events the dashboard already
  holds and that join up with the snapshot's events without a hole are kept: a resync must not
  take away what the user was reading or had loaded.

### Recent events only

- New `config.dashboard.recentEvents` (20) in `src/shared/config.ts`. The page, `GET
  /api/dashboard` and every snapshot carry, per run, only its newest `recentEvents` events, oldest
  first. The number comes from the config `createApp` was given.
- New `PublicRun.eventCount`: the run's total number of events, wherever a `PublicRun` appears
  (the state, `run` messages). The dashboard keeps it right as events arrive: an `event` message
  for an event it didn't hold adds one.
- New `GET /api/runs/:id/events?before=<id>&limit=<n>` answers 200
  `{ events: PublicEvent[], nextBefore: number | null }`:
  - `events`: the newest `limit` events of the run with an id below `before` (any id when `before`
    is absent), in ascending id order;
  - `limit`: 1 to 200, default 50;
  - `nextBefore`: the id of the oldest event returned, to pass as `before` for the next page, or
    `null` when there is nothing older (the page includes the run's first event, or is empty);
  - 400 `{ "error": "invalid_query", "field": "before" | "limit" }` when a parameter that is present
    isn't a positive integer written in decimal digits, or `limit` is above 200; 404
    `{ "error": "not_found" }` for an unknown run;
  - events as everywhere else: no `detail`, no secret.
- New `createDashboardClient(...).loadEarlierEvents(runId): Promise<void>`: fetches, with the
  client's `fetch` and `baseUrl`, the page of that run's events just before the oldest one the
  dashboard holds (`before` = that event's id), and adds them in front, oldest first, each event
  once. Calls made while one is in flight (a double click) never add an event twice. It does
  nothing once the dashboard holds all `eventCount` events of the run. It never rejects: a failed
  request leaves the state as it was. `onState` is called when the state changed.
- `Dashboard` and `RunList` take a new optional `onLoadEarlier(runId)` prop (passed through like
  `onCheck`). A run that shows fewer events than its `eventCount` has a `<button type="button">`
  "Load earlier events" that calls it; a run that shows all of them has none. Wire it up in
  `src/client/main.ts`.
- Stage 2's live region still announces from the events the dashboard holds. A page loaded after a
  run's resume has left its newest events has no resume to announce (the run's badge shows its
  status), and that is fine.

### Budgets

With a run of 5,000 events in the store: a snapshot under 100 KB of JSON, `GET /api/dashboard`
under 100 KB, the page under 150 KB.

### Everything else keeps working

Stages 1 and 2 still hold: README's Connectivity rules and the monitor's confirmation timeline
(each confirming check is one platform call made when the monitor asks), no secret in anything
the browser receives (the new endpoint and numbered messages included), no browser message that
stops the server, reconnect and resume without duplicates.

## How your work is checked

As in the earlier stages: the hidden tests import `src/index.ts` and `src/client/index.ts` (keep
every export), build the server with `createApp` (sometimes with a `config` of their own) and fake
platform adapters on one fake `Scheduler` shared with the browser code, connect real WebSocket
dashboards (up to 21 at once) driven by your `createDashboardClient`, count platform calls on the
fakes, record events with `app.store.appendEvent` (a change made through the store reaches every
dashboard, as it does today), call the HTTP API, and render components with
`vendor/preact/render-to-string.mjs`. Budgets are checked as byte counts, never as timings.

Run your tests with `npm test`. In `NOTES.md`, measure before and after: platform calls per
connection per interval with 1, 5 and 20 dashboards open, and the size of a snapshot and of the
page with a 5,000-event run. Explain what was causing the extra calls, the weight and the missing
events, what you changed and what it costs, how you used AI assistance, and what you verified
yourself.
