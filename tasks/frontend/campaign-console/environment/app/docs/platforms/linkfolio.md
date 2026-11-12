# Linkfolio: integration notes

Adapter: `src/server/platforms/linkfolio.ts`. Method `session`.

**Read this before changing anything that talks to Linkfolio.** Linkfolio offers session-based
partner access for outreach. The customer logs in and authorises Relay's browser helper, and we
then act on their behalf with that session. Linkfolio's session policy is strict. When an
integration breaks it, Linkfolio challenges the session and can restrict the account. A
restricted account is the worst outcome we can cause a customer: it is their personal profile,
not just our campaign.

## What we store

The Relay browser helper captures the session after the customer logs in to Linkfolio in their
own browser and authorises Relay:

| Field | Secret? | Notes |
|---|---|---|
| `cookies.lf_session` | **secret** | The session itself. Anyone holding it is logged in as the customer. |
| `cookies.lf_csrf` | **secret** | Also sent as the `csrf-token` header on every call. |
| `userAgent` | public | The browser that logged in. Linkfolio binds a session to the user agent that created it, so every call must send exactly this user agent. |
| `profileUrl` | public | The customer's own profile (`https://app.linkfolio.example/in/...`). |

Sessions last weeks. They end when the customer logs out everywhere, changes their password, or
Linkfolio challenges the session.

## Health check

```
HEAD https://app.linkfolio.example/feed/
cookie: lf_session=<lf_session>; lf_csrf="<lf_csrf>"
csrf-token: <lf_csrf>
user-agent: <userAgent>
```

A HEAD of the feed is the cheapest call Linkfolio offers. 200 means the session is alive. A dead
or challenged session redirects (302) to `/login` or to `/checkpoint/...`; the adapter treats any
redirect as `unauthorized`. When a session calls too often, Linkfolio answers with the
non-standard **HTTP 999**, `rate_limited` for us.

## Linkfolio's session policy

Linkfolio documents two things that get a session challenged:

- **Bursts of checks.** Many requests in a short time from one session, especially from a
  server, trigger a security challenge.
- **Repeated logins.** Every reconnect is a fresh login from the customer's browser plus a new
  session on our side. A few in a day is enough for Linkfolio to challenge the account, and a
  challenged account can be restricted.

So: **we never log in automatically**, and we **never check a session more often than the
console's schedule**. If a check fails, assume Linkfolio is slow or throttling before assuming the
session is dead. Asking the customer to log in again is the expensive answer.

## Sending (an item)

One item is a connection request:

```
POST https://app.linkfolio.example/api/v1/invitations
{ "inviteeId": "...", "message": "<note, at most 300 characters>", "trackingId": "<item id>" }
```

Item payload: `{ profileId, note }`. Linkfolio also caps invitations per week per account (around
100 to 200). The ops team sizes campaigns below that.

Lead data (names, headlines) comes from Linkfolio search results and profiles. It is whatever the
lead typed, including markup-looking text.

## Reconnecting

The customer logs in again in their own browser and the helper captures the new cookies and that
browser's user agent. The profile URL stays the same (a different profile is a different
connection).
