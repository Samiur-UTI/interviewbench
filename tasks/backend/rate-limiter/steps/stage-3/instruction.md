# Optimize

The limiter is now used per client IP. It sees millions of one-off keys a day and its
memory grows forever.

A bucket that has fully refilled behaves exactly like a brand-new bucket, so it doesn't
need to be stored. Make the limiter evict state it no longer needs:

- `len(limiter)` returns the number of keys currently tracked.
- Once a key has had no `allow` calls for at least `capacity / refill_rate` seconds,
  it must no longer be tracked after the next call to `allow` or `retry_after`.
- Observable behaviour (`allow` / `retry_after` results) must be identical to a limiter
  that never evicts.
- `allow` must stay fast: amortized O(1). 200,000 calls on distinct keys should take
  well under a few seconds.

Explain how eviction works and what it costs in `NOTES.md`, including how you used AI
assistance and what you checked yourself.
