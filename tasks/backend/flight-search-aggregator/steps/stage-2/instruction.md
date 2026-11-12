# Persist results and page through them

The results page is moving to server-side paging. Product and the booking team agreed on:

- **What we show is what we persisted.** Price check and booking read the offer from the
  database by `searchId` and `offerId`. A search must be answered only after all its rows are
  committed. `src/db/schema.ts` is the data team's schema: keep its tables and columns, and
  don't weaken the durability settings in `openDatabase` (no `synchronous=OFF`, no
  `journal_mode=OFF/MEMORY`, no in-memory database).
- **Users choose the order.** `cheapest`, `fastest`, `fewest_stops`, `preferred_airline`; the
  exact orders are in `README.md`. The search request's `sort` picks the first page; the user
  can switch order later without searching again.
- **Paging is stable**: no offer twice, none skipped, even while other searches are written.

Changes (export the new types and errors from `src/index.ts`):

    constructor(clients: SupplierClient[], options: { dbPath: string; defaultTimeoutMs?: number })

    searchWithStatus(req: SearchRequest, options?: { timeoutMs?: number; limit?: number })
      : Promise<SearchResult>
    getPage(searchId: string, options?: { sort?: SortPreference; cursor?: string; limit?: number })
      : Promise<Page>

    interface Offer extends Itinerary {}   // as read back from the database
    interface Page { offers: Offer[]; nextCursor: string | null }
    interface SearchResult {
      searchId: string;                   // new, unique (e.g. crypto.randomUUID())
      partial: boolean;
      suppliers: SupplierStatus[];        // as before
      total: number;                      // offers stored for this search
      page: Page;                         // first page, in req.sort (default "cheapest")
    }

`SearchResult.page` replaces `itineraries`: that is a requested product change.

Persisting:
- Write one `searches` row and one `supplier_results` row per supplier. For each offer, write
  an `offers` row with its sort columns, plus its `offer_segments` and `offer_prices` rows.
  Column formats are in `README.md` (`trip_key`, UTC times). A `supplier_results` row holds
  that supplier's `SupplierStatus` (`status`, and `offers` as `offer_count`).
  `offer_segments.leg_no` and `seg_no` count from 0, in journey and segment order.
- `searches.status` is `complete`, or `failed` when every supplier failed. A failed search
  still answers 503 and stores no offers; its pages are empty.
- Only offers that would be shown are stored: seat-filtered and de-duplicated.

Paging:
- `limit` is an integer from 1 to 200; the default is 50. `getPage`'s `sort` defaults to
  `"cheapest"`.
- `nextCursor` is `null` on the last page. Otherwise it is base64url (no padding) of the JSON
  `{"v":1,"s":<searchId>,"o":<sort>,"k":[<sort key values of the last offer on the page>, <its offerId>]}`.
  The sort key values, in order:

  | Sort | Keys |
  |---|---|
  | `cheapest` | total cents, then duration minutes |
  | `fastest` | duration, then total |
  | `fewest_stops` | stops, then total |
  | `preferred_airline` | pref rank (0 or 1), then total |

- The next page starts strictly after the cursor's position in the chosen order. A well-formed
  cursor is a position: it doesn't have to point at an offer that exists.
- `getPage` and `searchWithStatus` reject with `ValidationError` for:
  - a bad `limit`;
  - a cursor that doesn't decode to that shape, or that belongs to another search or another
    sort. A cursor must be a string that is exactly the base64url encoding (no padding) of its
    JSON: one with `=` padding or any other characters added is invalid, even if a lenient
    decoder accepts it;
  - a `sort` that isn't one of the four above;
  - `preferred_airline` on a search without `preferredCarrier`.
- `getPage` rejects with a new `SearchNotFoundError` for an unknown `searchId`.
- Pages are read from the database: a new service on the same `dbPath` must serve them.
- An `Offer` has exactly the fields and values of the `Itinerary` that was stored, and no
  others.

HTTP (`src/http/search-handler.ts`):
- `handleSearch` returns 200 `{ searchId, partial, suppliers, total, page }`, or 400/503 as
  before.
- New `handleGetPage(service, { searchId, sort?, cursor?, limit? })` returns:
  - 200 with a `Page`;
  - 400 for a `ValidationError`;
  - 404 for `SearchNotFoundError`.

Keep it correct and simple; making it fast is next. Run the tests with `npm test`, and explain
your design and its trade-offs in `NOTES.md`.
