# Meta Marketing API: integration notes

Adapter: `src/server/platforms/meta.ts`. Method `oauth`, but not the way Google does it.

## What we store

Customers connect with Facebook Login in the onboarding app; we exchange the short-lived token it
returns for a **long-lived user access token** and keep:

| Field | Secret? | Notes |
|---|---|---|
| `accessToken` | **secret** | Long-lived user token. Lasts about 60 days. |
| `expiresAt` | public | **ms since the epoch**. Shown on the card. |
| `scope` | public | `ads_management,ads_read`. |

There is **no refresh token** at Meta, ever. `refreshToken` is absent on Meta connections.

Our app ID and app secret (`META_APP_ID`, `META_APP_SECRET`) are used in some calls below. They
are ours, not the customer's, and never go in a credential.

## Renewing the token

A long-lived token can be exchanged for a fresh one **while it is still valid**. This is what the
adapter's `refresh` does:

```
GET https://graph.facebook.com/v21.0/oauth/access_token
    ?grant_type=fb_exchange_token&client_id=<app id>&client_secret=<app secret>&fb_exchange_token=<current token>
```

```json
{ "access_token": "EAAG...", "token_type": "bearer", "expires_in": 5183944 }
```

`expires_in` is in **seconds** (5183944 s is 60 days); we store `expiresAt = now + expires_in * 1000`
in ms. Once a token has expired, or was invalidated (password change, the user removed the app),
the exchange answers 400 (`OAuthException`, code 190) and only a reconnect helps. A Meta token
has to be renewed before it runs out, not after.

## Health check

```
GET https://graph.facebook.com/v21.0/debug_token?input_token=<customer token>&access_token=<app id>|<app secret>
```

Note the shape of the answer: an invalid customer token is **not** a 401. Graph answers 200 with
`{ "data": { "is_valid": false, "error": { "code": 190, ... } } }`, and the adapter turns that into
`unauthorized`. A 200 with `is_valid: true` is healthy.

**Quota.** `debug_token` is limited to about **200 calls per hour per user token**. Above that,
Graph throttles the calls (`rate_limited` for us) until the hour rolls over, and the throttle
counts against the same token our campaigns use. Every check we make spends from that budget.

## Sending (an item)

One item renames an ad set to the campaign's copy:

```
POST https://graph.facebook.com/v21.0/<ad set id>
authorization: Bearer <customer token>
name=<new name, at most 100 characters>
```

Item payload: `{ adSetId, name }`. The external id is the ad set id Graph returns.

## Reconnecting

The user goes through Facebook Login again; the onboarding app hands us a new long-lived token and
its `expires_in` in seconds. No refresh token. The scope and ad account stay the same.
