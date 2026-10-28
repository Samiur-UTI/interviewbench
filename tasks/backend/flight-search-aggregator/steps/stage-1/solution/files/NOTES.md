# Notes

## Stage 1: what was wrong, why, and how I fixed it

**Missing business fares, low result counts: the dedup key.** `itineraryKey` was the list of
flight numbers only. Two offers on XB581/XB582 were "the same trip" whether they were economy (K)
or business (J), and whether they flew on 1 or 2 December. The merge then kept the cheaper one,
which is almost always economy, so business fares vanished and counts dropped. The key now
follows README rule 3: per journey, per segment, flight number + departure time (UTC) + booking
class. Journey boundaries are part of the key, so the same segments grouped differently are
different trips. Supplier and price are deliberately *not* in the key: the same trip from
AeroLink and SkyMesh must still merge to the cheaper one.

**PRICE_MISMATCH on about 1 in 6 AeroLink bookings: float money.** `toMinorUnits` did
`Math.floor(parseFloat(x) * 100)`. Most 2-decimal values have no exact binary representation, so
for some of them (about 5%) the product lands just below the integer, e.g.
`578.68 * 100 = 57867.99999999999`, and `floor` drops a cent. AeroLink totals are the sum of
a converted base and converted taxes (about 3 amounts with decimals per offer), so roughly one
offer in six was 1-3 cents low, which the price check before booking rejects. Whole-dollar amounts
(carrier service fees) are always exact, which is why only some offers were off. SkyMesh sends an
integer `totalMinor`, so it never went through this code. It also accepted garbage: `"1e3"`
became 100000, `"12,50"` became 1200.

Fix: `toMinorUnits` parses `^\d+(\.\d{1,2})?$` as integers (dollars * 100 + cents) and throws on
anything else; `parseAeroLink` turns that into a `SupplierPayloadError` for the whole payload
(README rule 1: never guess a price).

Tests: merge regressions (K vs J, another day, journey split), exact conversion of every
7th cent value up to $100,000, rejection of malformed amounts, and the README example.

## Stage 2: deadlines and partial results (design and trade-offs)

## Stage 3: responsiveness and scaling (where the time went, what I changed, what it costs)

## How I used AI assistance (and what I checked myself)

I asked an assistant to explain the PRICE_MISMATCH pattern; it suggested `Math.round`, which
would also have fixed the totals, but would still have accepted `"1e3"` and `"12,50"`. I checked
the float claim with node (`578.68 * 100`) and with the exhaustive test above.
