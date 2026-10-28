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
for some of them (about 6%) the product lands just below the integer, e.g.
`41111.13 * 100 = 4111112.9999999995`, and `floor` drops a poisha. AeroLink totals are the sum of
a converted base and converted taxes (about 3 amounts with decimals per offer), so roughly one
offer in six was 1-3 poisha low, which the price check before booking rejects. Whole-taka amounts
(Bangladesh taxes) are always exact, which is why only some offers were off. SkyMesh sends an
integer `totalMinor`, so it never went through this code. It also accepted garbage: `"1e3"`
became 100000, `"12,50"` became 1200.

Fix: `toMinorUnits` parses `^\d+(\.\d{1,2})?$` as integers (taka * 100 + poisha) and throws on
anything else; `parseAeroLink` turns that into a `SupplierPayloadError` for the whole payload
(README rule 1: never guess a price).

Tests: merge regressions (K vs J, another day, journey split), exact conversion of every
7th poisha value up to 100,000 BDT, rejection of malformed amounts, and the README example.

## Stage 2: deadlines and partial results (design and trade-offs)

`searchWithStatus` calls every client at once, each with its own `AbortController`. One timer
is the deadline for the whole fan-out; each supplier's answer races it. A supplier that loses the
race is `"timeout"` and its signal is aborted; its promise still has both handlers attached, so a
late answer is dropped and a late rejection is never unhandled. A rejection or an unparsable
payload is `"error"` with a short message; the others still count.

Clean-up is in one `finally`: clear the timer, remove the listener on the caller's signal, abort
whatever hasn't answered. That runs on success, timeout and caller abort, so a settled search
leaves no timer, no listener and no running supplier call. The caller's signal is checked before
fan-out (already aborted: no calls at all) and raced against the fan-out afterwards.

Parsing happens after the wait, so the deadline covers waiting for suppliers, not our own work: a
supplier that answered in time is never reported as a timeout.

`search()` keeps its signature and returns partial results; when nobody answered it rejects with
`NoSuppliersAvailableError`, and `handleSearch` answers 503 with the statuses. An empty 200 would
tell an agent "no flights" when we simply couldn't ask anyone.

Trade-offs: one deadline for everyone is simple and predictable, but a supplier that is always
slow costs every search the full deadline; per-supplier budgets would be a later change. I kept
the 8 s default from the brief and validate `timeoutMs` (1..30000) up front, before any call.

## Stage 3: responsiveness and scaling (where the time went, what I changed, what it costs)

## How I used AI assistance (and what I checked myself)

I asked an assistant to explain the PRICE_MISMATCH pattern; it suggested `Math.round`, which
would also have fixed the totals, but would still have accepted `"1e3"` and `"12,50"`. I checked
the float claim with node (`41111.13 * 100`) and with the exhaustive test above.
