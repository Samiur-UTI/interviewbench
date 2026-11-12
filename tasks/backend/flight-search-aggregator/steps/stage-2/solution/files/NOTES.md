# Notes

## Stage 1: what was wrong, why, and how I fixed it

**Duplicate trips and negative travel times: Tessera dates.** Tessera schedules carry local times
but no date. A flight's date is the group's slice date for its leg plus
`legTable[].schedules[].departureDayOffset`, and its arrival date is that plus the schedule's
`arrival.dayOffset` (`docs/suppliers/tessera.md`, section 4.2). `parseTessera` dated every flight
of a leg on the slice date and never read `departureDayOffset`; the field wasn't even in our types,
which were written from a sample that didn't have it.

Why only some itineraries: Tessera omits default values, so the offset is only sent when it isn't 0,
which is when a connection departs on a later local day than the leg started, typically after an
overnight flight. In the QA capture (`dev/captures/tessera-qa-4471.json`) XB581 leaves Dubai at
22:30 on 1 Dec and lands in Delhi at 03:00 on 2 Dec; XB4417 (`departureDayOffset: 1`) leaves Delhi
at 06:15 on 2 Dec. We dated XB4417 on 1 Dec, a day too early:

- the connection "left" 20 h 45 min before XB581 landed, and the outbound journey lasted
  -725 minutes, so the itinerary showed -280 minutes instead of 1160;
- its departure time is part of the trip key (README rule 3), so it no longer matched the same
  trip from Caravel and Keystone, and both copies were shown, at 1402.50 and 1406.80.

The arrival offset was already applied, but on top of the wrong departure date, so it was wrong by
the same day.

Fix: `readLeg` reads `departureDayOffset` (0 when omitted), and `legFlights` dates each flight
from slice date + its offset, and its arrival from that departure date. I didn't touch durations,
dedup or `legTable[].elapsedMinutes`: they were symptoms, and patching them would have hidden a
wrong departure time that we would then persist and try to book.

**PRICE_MISMATCH on Caravel and Keystone bookings: float money.** `toMinorUnits` did
`Math.floor(parseFloat(x) * 100)`. Most 2-decimal values have no exact binary representation, and
for some the product lands just below the integer: `1037.11 * 100 = 103710.99999999999`, so
`floor` dropped a cent (`"0.29"` -> 28, `"4.35"` -> 434). Caravel sends every amount as a decimal
string and Keystone as `"USD1037.11"`, so both went through it. Tessera sends integer cents and
never did, which is why its bookings never failed. It also accepted garbage: `"1e3"` became 100000,
and Keystone's `slice(3)` accepted any currency.

Fix:
- `toMinorUnits` parses `^(0|[1-9]\d*)\.\d{2}$` as integers (dollars * 100 + cents) and throws a
  `SupplierPayloadError` on anything else (README rule 1: never guess an amount).
- `parseUsd` checks the `USD` prefix before converting; Keystone uses it.
- Now that parsing is exact, the parsers cross-check what the supplier sends: Caravel
  `grandTotal = total + fees` and the traveller prices add up to `total`; Keystone
  `basePrice + taxes = totalPrice`, the pricingInfo totals add up to it, and each type's total
  splits evenly over its passengers. A payload that fails one is a supplier error rather than a
  price we can't honour. (These would have fired at random with float parsing.)

Tests: the QA capture's dates and durations, the arrival offset counted from the flight's own
departure, the Tessera copy merging with Caravel's again, exact conversion of every 7th cent value
up to $100,000, rejection of malformed amounts, and the cross-checks.

Not changed, worth discussing: the trip key ignores the fare basis. Two suppliers can sell the same
booking class under different fare bases (a negotiated fare against a public one), with different
rules. README rule 3 says booking class decides, so I kept it.

## Stage 2: persistence and paging (design and trade-offs)

**What is stored.** `searchWithStatus` asks the suppliers as before, then writes, before it
answers: one `searches` row (`failed` when no supplier answered), one `supplier_results` row per
supplier, and for each offer that would be shown (seat-filtered, then de-duplicated) its `offers`
row plus `offer_segments` and `offer_prices`. Price check and booking read these rows from another
connection, so "answered" must mean "committed"; WAL lets them read while we write. The sort keys
(`total_cents`, `duration_min`, `stops`, `pref_rank`) are denormalised onto `offers` at write time,
so every order can later be served from that one table. `pref_rank` freezes the preference at
search time, which is what the README asks for: the preference belongs to the search.

**Paging.** Each order is a total order ending in the offer id, so "the next page starts strictly
after the last offer shown" is well defined even with many equal prices. The cursor is that
position (`k` = the two sort keys + the id), scoped to one search and one sort, and base64url so
it is opaque to clients. A position doesn't have to name an existing offer, which keeps paging
stable whatever else is written meanwhile: other searches have other ids, and a stored search
never changes. An offset cursor would not have that property if rows were ever deleted (the TTL
job) and it costs more the deeper you page.

**Validation.** `limit` is 1..200 (default 50) on both entry points. A cursor that doesn't decode
to exactly the agreed shape, isn't exactly the encoding we issue (`Buffer.from` would also accept
it with padding), or was issued for another search or another sort, is a `ValidationError`, as
is an unknown sort or `preferred_airline` on a search without a carrier (it would silently be
"cheapest" otherwise). An unknown id is `SearchNotFoundError` (HTTP 404).

**Deliberately simple for now.** Every row is its own statement and its own commit, and a page
is cut from the whole search sorted in JavaScript. That is correct and easy to check against the
README's orders. It is also the obvious place to optimise next (each autocommit is an fsync at
`synchronous=FULL`, and a page costs as much as the whole search).


## Stage 3: the 1-second budget (where the time went, what I changed, what it costs)

## How I used AI assistance (and what I checked myself)

I asked an assistant to explain the negative durations; it first suggested taking durations from
`legTable[].elapsedMinutes`, which would have hidden the wrong departure time. I traced the chain
from `itinerary.legs[].ref` through `legTable` to `scheduleTable` against the capture myself, and
checked the float claim in node (`1037.11 * 100`) and with the exhaustive test.
