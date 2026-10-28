# flight-search

The service behind Example Travels' flight results page. Example Travels is an online travel agency
in Dhaka. Its users are:

- **B2C customers** on the website and app;
- **B2B travel agents** on the agent portal, who search for their clients (often multi-city),
  including corporate clients who fly business class.

Most searches are international (DAC-DXB, DAC-SIN, DAC-KUL): one-way, return or multi-city.

## How a search works

1. `FlightSearchService.search(req)` validates the request (`src/validate.ts`).
2. It asks every configured fare supplier at once (`SupplierClient`, `src/suppliers/types.ts`).
   The order of the clients passed to the constructor is the **supplier preference order**.
3. Each raw response is parsed into the common `Itinerary` shape (`src/types.ts`):
   - **AeroLink** (`src/suppliers/aerolink.ts`): nested JSON, local times with UTC offsets.
     Fares and carrier taxes are filed in foreign currencies (USD/AED/SGD/MYR); AeroLink converts
     them to BDT and sends decimal strings with up to 2 decimals. Bangladesh taxes (e.g. `BD`)
     come in whole taka.
   - **SkyMesh** (`src/suppliers/skymesh.ts`): flat JSON, one row per fare, segments packed into
     pipe-delimited strings, UTC timestamps, and a total already in poisha.
4. Offers without enough seats are dropped, then duplicates are merged and the list is sorted
   (`src/merge.ts`).

`handleSearch(service, body)` (`src/http/search-handler.ts`) stands in for the HTTP route.

## Business rules

1. **Never show a fare the supplier can't honour.**
   - The price we show equals the supplier's total, to the poisha.
   - Offers with fewer seats than passengers are hidden. The seat check happens before
     duplicates are merged, so a sold-out cheap copy can't hide an available one.
   - An amount we can't read exactly is a supplier error. Never guess or round.
2. **Prices are integer poisha in BDT** inside the service (1 BDT = 100 poisha).
3. **Two offers are the same trip only if** they have the same journeys and, segment by segment,
   the same flight number, departure time and booking class.
   - Economy and business are different products.
   - In this service, fare conditions (baggage, refundability) are fully determined by booking
     class.
4. **Duplicates are shown once, at the cheapest price.** On a price tie, the preferred supplier
   (earlier client) wins.
5. **Ordering:** cheapest first, then shorter total duration, then preferred supplier, then
   `supplierRef`.
6. `Itinerary.id` is `${supplier}:${supplierRef}`.

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
