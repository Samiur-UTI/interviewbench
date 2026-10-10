# Add a feature

Clients want to know *when* to retry instead of polling.

Add `RateLimiter.retry_after(key: str, cost: float = 1) -> float`:

- Returns the number of seconds until a request of `cost` for `key` would be allowed,
  or `0.0` if it would be allowed right now.
- Must **not** consume tokens.
- Waiting exactly the returned time and then calling `allow(key, cost)` must succeed.

Also, a request whose `cost` is greater than the bucket capacity can never succeed, and
a `cost <= 0` makes no sense. Both `allow` and `retry_after` must raise `ValueError`
for these.

Explain your design in `NOTES.md`.
