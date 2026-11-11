# LinkedIn: integration notes

Adapter: `src/server/platforms/linkedin.ts`. Method `session`.

**Read this before changing anything that talks to LinkedIn.** There is no API for outreach, so we
act through the customer's own browser session, and LinkedIn restricts accounts that look
automated. A restricted account is the worst outcome we can cause a customer: their personal
profile, not just our campaign.

## What we store

The Relay browser helper captures the session after the customer logs in to LinkedIn in their
own browser:

| Field | Secret? | Notes |
|---|---|---|
| `cookies.li_at` | **secret** | The session itself. Anyone holding it is logged in as the customer. |
| `cookies.JSESSIONID` | **secret** | Also sent as the `csrf-token` header on every call. |
| `userAgent` | public | The browser that logged in. Calls must use exactly this user agent; a session that suddenly comes from another browser is a red flag for LinkedIn. |
| `profileUrl` | public | The customer's own profile (`https://www.linkedin.com/in/...`). |

Sessions last weeks. They end when the customer logs out everywhere, changes their password, or
LinkedIn decides to challenge the session.

## Health check

```
HEAD https://www.linkedin.com/feed/
cookie: li_at=<li_at>; JSESSIONID="<JSESSIONID>"
csrf-token: <JSESSIONID>
user-agent: <userAgent>
```

The feed is what an open LinkedIn tab loads anyway, so a HEAD of it is cheap and unremarkable.
200 means the session is alive. A dead or challenged session redirects (302) to `/login` or to
`/checkpoint/...`; the adapter treats any redirect as `unauthorized`. LinkedIn's "slow down"
answer is the non-standard **HTTP 999**, `rate_limited` for us.

## What gets accounts restricted

- **Bursts of checks.** Many requests in a short time from one session, especially from a
  server, trigger a security challenge.
- **Repeated logins.** Every reconnect is a fresh login from the customer's browser plus a new
  session appearing on our side. A few in a day is enough for LinkedIn to challenge the account,
  and a challenged account can be restricted.

So: **we never log in automatically**, and we **never check a session more often than the
console's schedule**. If a check fails, assume LinkedIn is slow or throttling before assuming the
session is dead; asking the customer to log in again is the expensive answer.

## Sending (an item)

One item is a connection request:

```
POST https://www.linkedin.com/voyager/api/growth/normInvitations
{ "invitee": { "com.linkedin.voyager.growth.invitation.InviteeProfile": { "profileId": "..." } },
  "message": "<note, at most 300 characters>", "trackingId": "<item id>" }
```

Item payload: `{ profileId, note }`. LinkedIn also caps invitations per week per account (around
100 to 200); campaigns are sized below that by the ops team.

Lead data (names, headlines) comes from LinkedIn search results and profiles: it is whatever the
lead typed, including markup-looking text.

## Reconnecting

The customer logs in again in their own browser and the helper captures the new cookies and that
browser's user agent. The profile URL stays the same (a different profile is a different
connection).
