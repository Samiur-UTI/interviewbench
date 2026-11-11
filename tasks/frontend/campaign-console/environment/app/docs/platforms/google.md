# Google Ads: integration notes

Adapter: `src/server/platforms/google.ts`. Method `oauth`.

## What we store

The customer grants us offline access to their Google Ads account through the OAuth consent screen
in the onboarding app. We keep:

| Field | Secret? | Notes |
|---|---|---|
| `accessToken` | **secret** | Bearer token for API calls. Lives 3600 s. |
| `refreshToken` | **secret** | Gets new access tokens. Long-lived, but see "Refresh tokens". |
| `expiresAt` | public | When the access token stops working, **ms since the epoch** (ours, see below). Shown on the card as "Token expires". |
| `scope` | public | `https://www.googleapis.com/auth/adwords`. |

Every API call also carries our **developer token** (`developer-token` header). That one is ours,
not the customer's; it comes from `GOOGLE_ADS_DEVELOPER_TOKEN` and never goes in a credential.

## Tokens: seconds vs milliseconds

Google's token endpoint answers with `expires_in` in **seconds**, relative to the response:

```json
{ "access_token": "ya29.a0Af...", "expires_in": 3599, "scope": "https://www.googleapis.com/auth/adwords", "token_type": "Bearer" }
```

We store an absolute `expiresAt` in **milliseconds** (`now + expires_in * 1000`), because every
clock in the console is a ms epoch. Mixing the two units has bitten us before: a token stored as
`now + 3599` "expires" the moment it is written.

## Refreshing

```
POST https://oauth2.googleapis.com/token
content-type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<refresh token>&client_id=<ours>&client_secret=<ours>
```

- Answers the JSON above. A new `refresh_token` is **not** included: Google issues one only when
  the user goes through consent again. Keep the one we have.
- A dead refresh token (the user removed our access, changed their password, or it went unused for
  six months) answers 400 `{"error":"invalid_grant"}`. Nothing but a reconnect fixes that.
- The token endpoint rate-limits bursts of refreshes for the same grant (we get 429, which is
  `rate_limited` for us). Refresh once per connection, not once per caller.
- Google keeps a limited number of live refresh tokens per account and client; issuing more
  silently invalidates the oldest. Every reconnect with a new consent burns one.

## Health check

```
GET https://googleads.googleapis.com/v19/customers:listAccessibleCustomers
authorization: Bearer <access token>
developer-token: <ours>
```

The cheapest authenticated call there is: it lists the customer IDs the token can reach and costs
no API operations. 200 means the token works. An expired or revoked access token answers 401
`UNAUTHENTICATED` ("Request had invalid authentication credentials"); a token that is merely an
hour old is the usual reason.

## Sending (an item)

One item creates a paused responsive search ad in the item's ad group:

```
POST https://googleads.googleapis.com/v19/customers/<customer id>/adGroupAds:mutate
{ "operations": [ { "create": { "adGroup": "customers/<cid>/adGroups/<id>", "status": "PAUSED",
  "ad": { "responsiveSearchAd": { "headlines": [ { "text": "..." } ] } } } } ] }
```

Item payload: `{ adGroup, headline }`. The external id is the created ad's `resourceName`.

## Reconnecting

The user goes through consent again in the onboarding app. The result is an access token, its
`expires_in` (seconds) and, usually, a refresh token. If the consent didn't return a refresh token
(the user had granted us access before and Google skipped it), keep the stored one. The scope and
account stay the same.

## When something goes wrong

The adapter keeps the request (URL, method, which authorization was used) in the error details and
names the rejected token in the error message, so support can match it against the grant in the
Google Cloud console.
