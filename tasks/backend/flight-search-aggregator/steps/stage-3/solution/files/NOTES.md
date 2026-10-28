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

**Where the time went.** Two things, both on the one thread that serves every request:

1. Parsing. `parsePayload` ran on the event loop. For a ~77 MB AeroLink response, `JSON.parse`
   alone takes 150-250 ms on my machine, normalising adds more, and both suppliers were parsed
   back to back, so the loop stalled for 250+ ms per big search: health checks and everybody
   else's searches waited. Chunking the normalisation doesn't help: a single `JSON.parse` of the
   whole string is already longer than we can afford.
2. Merging. `mergeItineraries` looked keys up with `Array#indexOf`: O(n^2). 40k offers took
   ~1.4 s, 80k ~6 s.

**What I changed.**
- `src/parsing/worker-pool.ts` + `parse-worker.ts`: a fixed pool of parser threads
  (`parserThreads`, default `availableParallelism() - 1`, so one core stays with the event loop),
  FIFO queue, lazy start. A worker that errors or exits rejects its in-flight job (the supplier
  becomes `"error"`) and is replaced on demand, so a crash can't hang a search. Idle workers are
  unref'd; `close()` rejects queued jobs and terminates every thread, and is idempotent; after it,
  searches reject.
- The search still waits for suppliers under the deadline first, then parses: the deadline
  covers waiting, not parsing (a supplier that answered in time is never a timeout).
- `mergeItineraries`: one pass with a `Map` from key to best offer, then one stable sort. It
  visits offers in the same order with the same "better" rule, so results are identical (a test
  compares it with the old implementation on data full of ties). 150k offers: ~150 ms.
- I parse every payload in the pool, small ones too. For a 50 KB payload a thread round trip
  costs about a millisecond more than parsing inline, but one code path is simpler and a "small"
  supplier can turn big without warning.

**What it costs.**
- Copying: the raw string is copied into the worker (a memcpy of ~77 MB on the main thread; that
  is the main remaining pause, ~20 ms max with a 5 ms heartbeat on my machine). The parsed
  itineraries are copied back, but they are small (the bulk fields are dropped in the worker).
- Memory: during a big search the payload exists twice (caller's string + the worker's copy)
  plus the worker's parsed tree, which is freed after the job. Each thread has its own heap.
- Startup: the first search starts the threads (tens of ms each, they load the TypeScript
  sources). Later searches reuse them.
- A caller abort during parsing is only noticed when parsing ends; the thread can't be
  interrupted mid-parse without killing it.

## How I used AI assistance (and what I checked myself)

I asked an assistant to explain the PRICE_MISMATCH pattern; it suggested `Math.round`, which
would also have fixed the totals, but would still have accepted `"1e3"` and `"12,50"`. I checked
the float claim with node (`41111.13 * 100`) and with the exhaustive test above.

For stage 2 the assistant's first draft used `Promise.race` against `setTimeout` without
clearing the timer and added the abort listener without removing it; I caught both with tests
that check `getEventListeners` and that a child process exits on its own. For stage 3 it
proposed `setImmediate` chunking of the normaliser; measuring showed `JSON.parse` alone was the
long pause, so I moved the whole parse into worker threads instead. I measured the heartbeat gap
and merge timings myself.
