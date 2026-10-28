# Deadlines and partial results

Today one slow or broken supplier ruins the whole search: if SkyMesh hangs, customers stare at a
spinner until the gateway gives up, and if AeroLink sends one bad payload, everyone gets an error
even though SkyMesh answered fine.

Product rules for this change:

- **Partial results beat no results.** A supplier that fails or misses the deadline must not
  delay or sink the others.
- **"We couldn't ask anyone" is not "there are no flights".** If every supplier fails, the API
  must say so (HTTP 503), never return an empty 200.
- **Don't keep paying for searches nobody is waiting for.** Supplier calls we stop waiting for
  must be cancelled through their `AbortSignal`.

Add to `FlightSearchService` (export new types and errors from `src/index.ts`):

```ts
constructor(clients: SupplierClient[], options?: { defaultTimeoutMs?: number })  // default 8000

searchWithStatus(req: SearchRequest, options?: { timeoutMs?: number; signal?: AbortSignal })
  : Promise<SearchResult>

interface SupplierStatus {
  supplier: string;                    // SupplierClient.name
  status: "ok" | "error" | "timeout";
  offers: number;                      // itineraries parsed from this supplier, before seat
                                       // filtering and de-duplication; 0 unless "ok"
  error?: string;                      // short message when status is "error"
}
interface SearchResult {
  itineraries: Itinerary[];            // same rules as before
  partial: boolean;                    // true if any supplier is not "ok"
  suppliers: SupplierStatus[];         // one per client, in client order
}
```

Behaviour:

- All suppliers are called concurrently, each with its own `AbortSignal`.
- `timeoutMs` (default: the service's `defaultTimeoutMs`) is one deadline for the whole fan-out,
  measured from the call. It covers waiting for suppliers, not parsing their responses. A
  supplier that hasn't responded by then gets status `"timeout"` and its signal is aborted.
  Anything it returns or throws later is ignored.
- A supplier whose call rejects, or whose payload can't be parsed, gets status `"error"`.
- `searchWithStatus` does not reject because suppliers failed. If all fail, it resolves with no
  itineraries and `partial: true`.
- If the caller's `signal` aborts (or is already aborted), every pending supplier call is aborted
  (or none is made) and `searchWithStatus` rejects with the signal's `reason`.
- For an invalid request, or an invalid `timeoutMs` (it must be an integer from 1 to 30000),
  `searchWithStatus` rejects with `ValidationError` before any supplier is called.
- Once the returned promise settles, nothing the search started may keep the process alive, and
  no listeners may remain on the caller's `signal`.
- `search(req)` keeps returning `Itinerary[]`, using the same logic. It returns partial results
  when some suppliers fail, and rejects with a new exported `NoSuppliersAvailableError` when
  every supplier failed.
- `handleSearch` returns 200 with `{ itineraries, partial, suppliers }`, 400 for a
  `ValidationError`, and 503 with `{ error, suppliers }` when every supplier failed.

Explain your design and its trade-offs in `NOTES.md`.
