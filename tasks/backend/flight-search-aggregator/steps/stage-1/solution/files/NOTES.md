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

## Stage 3: the 1-second budget (where the time went, what I changed, what it costs)

## How I used AI assistance (and what I checked myself)

I asked an assistant to explain the negative durations; it first suggested taking durations from
`legTable[].elapsedMinutes`, which would have hidden the wrong departure time. I traced the chain
from `itinerary.legs[].ref` through `legTable` to `scheduleTable` against the capture myself, and
checked the float claim in node (`1037.11 * 100`) and with the exhaustive test.
