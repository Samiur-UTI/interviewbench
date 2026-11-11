# Twilio Programmable Messaging: integration notes

Adapter: `src/server/platforms/twilio.ts`. Method `api_key`.

## What we store

Customers create an API key for us in their Twilio console (Account > API keys) and paste it into
the onboarding app. We never ask for the account's auth token.

| Field | Secret? | Notes |
|---|---|---|
| `accountSid` | public | `AC` + 32 hex characters. Identifies the customer's Twilio account. |
| `apiKeySid` | public | `SK` + 32 hex characters. Identifies the key. Shown on the card so customers can tell which key we use. |
| `apiKeySecret` | **secret** | Shown once by Twilio when the key is created. Anyone holding it can send SMS on the customer's account and bill them. |

## Authentication

HTTP basic auth with the key: `authorization: Basic base64(<apiKeySid>:<apiKeySecret>)`. The URLs
carry the account SID.

API keys **never expire**. A key stops working only when the customer deletes it, which they do
when rotating keys (create a new one, give it to us, delete the old one).

## Health check

```
GET https://api.twilio.com/2010-04-01/Accounts/<accountSid>.json
authorization: Basic ...
```

200 with the account resource when the key works. A deleted key answers 401 (Twilio error 20003,
"Authenticate"). The account's `status` (`active`, `suspended`, `closed`) is in the body; we don't
act on it yet.

**Limits.** Twilio limits concurrent API requests per account; over the limit it answers 429
(error 20429), `rate_limited` for us. Messages themselves are queued by the Messaging Service.

## Sending (an item)

```
POST https://api.twilio.com/2010-04-01/Accounts/<accountSid>/Messages.json
To=<E.164 number>&MessagingServiceSid=<ours>&Body=<text>
```

Item payload: `{ to, body }`. The external id is the message SID (`SM...`).

## Reconnecting

A reconnect gives us a new key pair: a **new `apiKeySid` and `apiKeySecret` is normal** (that is
what rotating means). The **account SID can't change**: the numbers, the opt-out list and the
message history belong to the account, so a different account is a new connection, not a
reconnect. The onboarding app shows the account SID read-only for that reason.

## When something goes wrong

A 401 comes back with the key named in the error message (customers rotate keys often and support
needs to know which one was rejected), and the request is kept in the error details.
