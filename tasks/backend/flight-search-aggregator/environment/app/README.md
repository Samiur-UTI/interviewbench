# flight-search

The service behind the flight results page of an online travel agency. Its users are:

- **B2C customers** on the website and app;
- **B2B travel agents** on the agent portal, who search for their clients (often multi-city),
  including corporate clients who fly business class.

Most searches are international (LHR, FRA, JFK, DXB, SIN): one-way, return or multi-city, for up
to 9 passengers (adults and children).

## How a search works

1. `FlightSearchService.searchWithStatus(req)` validates the request (`src/validate.ts`).
2. It asks every configured fare supplier at once (`SupplierClient`, `src/suppliers/types.ts`).
   The order of the clients passed to the constructor is the **supplier preference order**.
3. Each raw response is parsed into the common `Itinerary` shape (`src/types.ts`).
4. Offers without enough seats are dropped, then duplicates are merged and the list is sorted
   (`src/merge.ts`).

`handleSearch(service, body)` (`src/http/search-handler.ts`) stands in for the HTTP route.

## Suppliers

All three are fare aggregators (GDS-style). Their responses are deeply nested and lean on
references, so every parser follows chains of keys from the offer to its flights and fares. Our
notes on each format are in `docs/suppliers/`, and `tests/fixtures/` has one response from each
for the same search.

| Supplier | Parser | Shape | Times | Money |
|---|---|---|---|---|
| **Caravel** | `src/suppliers/caravel.ts` | One entry per offer; airports in a lookup dictionary; cabin and booking class per traveller and segment, joined by `segRef` | Local, no offset; the offset is in `lookups.airports` | USD decimal strings; fees on top of `total` |
| **Tessera** | `src/suppliers/tessera.ts` | Description tables (schedules, legs, fare components) referenced by id; several quotes (brands) per itinerary | Local time with offset, no date; dates come from the search's slices | Integer US cents |
| **Keystone** | `src/suppliers/keystone.ts` | Keyed lists converted from XML; one price point covers every combination of its per-leg options | ISO with offset | `"USD1406.80"` strings |

Shared readers for untrusted JSON are in `src/suppliers/fields.ts`. A response that doesn't match
its format is a `SupplierPayloadError` for that supplier: we never show part of a payload we can't
read.

## Database

`src/db/schema.ts` holds the search tables (`SCHEMA_SQL`) and `openDatabase(path)`, which opens a
SQLite file with `node:sqlite` and applies the schema. The tables are owned by the data team and
read by the price check and booking service: keep table and column names and types. You may add
indexes. Nothing in the service writes to the database yet.

## Business rules

1. **Never show a fare the supplier can't honour.**
   - The total equals the supplier's total for the whole party, to the cent.
   - Offers with fewer seats than `adults + children` are hidden. The seat check happens before
     duplicates are merged, so a sold-out cheap copy can't hide an available one.
   - The total is what the customer pays: base + taxes + the supplier's fees.
   - An amount or reference we can't resolve exactly is a supplier error. Never guess or round.
     So is an amount not written exactly as its supplier's notes in `docs/suppliers/` say: the
     whole response is a `SupplierPayloadError`.
2. **Prices are integer US cents** inside the service (1 USD = 100 cents).
3. **Same trip** means the same journeys and, per segment, the same marketing flight number,
   departure time (UTC), origin and destination, booking code and cabin.
   - Codeshare flights sold under different flight numbers are different products.
   - So are two booking codes in the same cabin (K vs L): fare conditions (baggage,
     refundability, changes) are determined by booking class.
   - The key is `itineraryKey` in `src/merge.ts`, stored as `offers.trip_key`:

     ```ts
     legs.map(l => l.segments.map(s =>
       `${s.flightNumber}@${s.departureUtc}:${s.origin}-${s.destination}/${s.bookingCode}/${s.cabin}`
     ).join(",")).join("|")
     ```

     All UTC times, including `first_departure_utc`, are `Date#toISOString()`.
4. **Duplicates are shown once, at the cheapest price, whatever the sort preference.** On a price
   tie, the preferred supplier (earlier client) wins.
5. **Sort preferences.** Each is a total order; `offerId` (`Itinerary.id`) is compared as a binary
   string.
   - `cheapest`: total price, then duration, then `offerId`.
   - `fastest`: duration, then total price, then `offerId`.
   - `fewest_stops`: stops, then total price, then `offerId`.
   - `preferred_airline`: offers whose `validatingCarrier` (the plating carrier, which holds our
     corporate agreements) equals the search's `preferredCarrier` come first, then total price,
     then `offerId`. The preference is part of the search. It changes the order, never filters:
     other airlines' offers still appear.
6. **What we show is what we persisted.** The price check and booking service reads offers from
   the database by `searchId` and `offerId`. A search is answered only after its offers are
   committed, and the database's durability settings (`openDatabase`) must not be weakened. The
   database is shared with the booking and orders tables, and the data team sets its connection
   policy.
7. **Paging is stable.** Walking the pages of a search never shows an offer twice or skips one,
   even while other searches are being written.
8. **Partial results beat no results.** A supplier that fails or misses the deadline is reported
   in `suppliers` and the others are still shown; when no supplier could be asked successfully the
   search is a 503.
9. `Itinerary.id` is `${supplier}:${supplierRef}`. Offer ids are ASCII, so SQLite and JavaScript
   string order agree.

## TypeScript in this repo

The code runs directly on Node.js 24 (built-in type stripping): there is no build step. That
means:

- Only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties.
- Relative imports carry the `.ts` extension (`import { x } from "./merge.ts"`).
- Use `import type { ... }` for type-only imports. A plain `import { Itinerary }` of an interface
  fails at runtime with a SyntaxError.
- No npm dependencies. Use what Node.js ships with.

## Commands

```bash
npm test             # node --test over tests/**/*.test.ts
npm run typecheck    # optional: tsc --noEmit (TypeScript is installed in the task image)
```

Requires Node.js 24.11 or later.
