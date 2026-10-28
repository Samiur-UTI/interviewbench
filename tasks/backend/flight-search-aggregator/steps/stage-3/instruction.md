# Meet the 1-second budget

Product's target: **once the last supplier has answered (or the deadline has passed), the
first page must be ready within 1 second**. That covers parsing, merging, writing and reading
the first page. At peak an agent's multi-city search returns thousands of offers from each
supplier. Today a search like that takes several seconds after the suppliers answer, and the
service freezes while it parses: health checks time out and other users wait.

Requirements:
- Results, order, statuses and stored rows stay exactly as they are today.
- Durability stays as it is: same `openDatabase` settings, a real database file, rows
  committed before the response.
- **Writes are batched.** A search's rows must not be committed row by row (however the SQL
  is sent), and no statement may be prepared per row.
- **Paging uses the database properly.** For every sort, a page must be read through an index
  in that order. A page after the first must **seek to the cursor position**: no sorting step,
  no full scan, no `OFFSET`, no reading the whole search and filtering in JS or SQL. Each page
  reads only about the rows it returns. Add the indexes you need; don't rename tables or
  columns.
- **Parsing stays off the event loop.** Supplier payloads can be tens of MB. Our test runs a
  5 ms heartbeat during a search with one very large payload. Until the search starts writing
  to the database, the heartbeat's longest gap must be under half the time `JSON.parse` of that
  payload alone takes on the same machine (and at least 50 ms). `worker_threads` are available
  (start workers from a file, not with `eval`). Writing on the main thread is allowed.
- The supplier deadline still covers waiting only: a supplier that answered in time is not a
  `"timeout"` because parsing its response is slow.
- New option `parserThreads?: number` (an integer >= 1, default
  `Math.max(1, os.availableParallelism() - 1)`). Any other value makes the constructor throw
  `ValidationError`.
- New `close(): Promise<void>` releases threads and database handles, so the process can exit
  on its own. It is safe to call twice. After it, searches and `getPage` reject.
- A payload that fails to parse still gives that supplier `"error"`, and the service keeps
  working.

In `NOTES.md`: where the time went (measure it), what you changed and why each change matters,
what it costs (copies between threads, index write cost, memory), how you used AI assistance,
and what you verified yourself.
