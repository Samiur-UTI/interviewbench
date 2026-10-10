# Notes

## Stage 1: what was wrong and how I fixed it

`TokenBucket._refill` added `elapsed * refill_rate` tokens with no upper bound. While a key
was busy, `elapsed` stayed small, so the bug was invisible. After a quiet period, `elapsed` was
huge and the bucket held thousands of tokens, which allowed a matching burst.

Fix: cap the refill at `capacity` inside `TokenBucket` (the root cause), not in `RateLimiter`.
Added a regression test that idles for an hour and checks the burst is exactly `capacity`.

## Stage 2: design of retry_after

`TokenBucket.time_until(cost)` refills, then returns `(cost - tokens) / refill_rate`
(or 0 if allowed). It never changes the token count, so calling it is side-effect free.
`RateLimiter.retry_after` delegates to it.

Float rounding: waiting exactly the returned time could leave the bucket at 0.9999999 tokens
for a cost of 1, so `allow` and `time_until` both accept a 1e-9 tolerance.

Cost validation lives in `TokenBucket._check_cost`, so both methods raise the same `ValueError`.

## Stage 3: how eviction works and its cost

A key idle for `capacity / refill_rate` seconds is guaranteed to be full, and a full bucket is
identical to a new one. So it can be dropped with no observable change.

Keys are kept in an `OrderedDict` ordered by last `allow`. Each call pops expired keys from the
front until it finds one that is still recent. Every key is evicted at most once, so this is
amortized O(1) per call and O(active keys) memory.

Trade-off: a bucket that refilled early (e.g. used 1 of 5 tokens) is kept for the full window.
That's simpler and still bounds memory to keys used in the last window.

## How I used AI assistance (and what I checked myself)

Reference solution, written by hand. Verified with the hidden tests and the tests above.
