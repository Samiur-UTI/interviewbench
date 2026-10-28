# Keep the service responsive under big searches

B2B agents now run large multi-city searches. AeroLink returns thousands of offers per search,
each with bulky fare components, baggage and brand data, so a single response can be close to
100 MB of JSON. During those searches the whole service stalls: health checks time out and every
other customer's search waits behind one agent's. Profiling shows two problems:

1. Parsing and normalising a large payload blocks the Node.js event loop for hundreds of
   milliseconds.
2. Merging gets dramatically slower as the number of offers grows.

Fix both, without changing any result.

Requirements:

- Results (itineraries, their order, supplier statuses) stay exactly what they are today.
- `mergeItineraries` must scale: merging 150,000 offers must take well under a second or two.
- While a search parses a large payload, the event loop must stay responsive. Our test runs a
  5 ms heartbeat timer during a search over one very large payload and requires its longest gap
  to be under half the time that `JSON.parse` of that payload alone takes on the same machine
  (and under 50 ms at least). So no approach that runs `JSON.parse` over the whole payload on the
  main thread can pass. Node's `worker_threads` are available (they can load `.ts` files); don't
  add npm dependencies.
- The stage 2 deadline still covers waiting for suppliers only: a supplier that answered in time
  must not be reported as `"timeout"` because parsing its response is slow.
- New constructor option `parserThreads?: number`. It must be an integer >= 1; the default is
  `Math.max(1, os.availableParallelism() - 1)`. Any other value makes the constructor throw
  `ValidationError`.
- New method `close(): Promise<void>`. It releases threads and anything else, so the process can
  exit on its own. It is safe to call more than once. After `close()`, searches reject with an
  `Error`.
- A payload that fails to parse still gives that supplier status `"error"`, and later searches on
  the same service still work.
- Small payloads may still be parsed on the main thread if you think that's better; say why in
  `NOTES.md`.

In `NOTES.md`, explain where the time went, what you changed, what it costs (memory, copying data
between threads, startup), how you used AI assistance, and what you verified yourself.
