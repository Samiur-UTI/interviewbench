# Notes

## Stage 1: what was wrong and how I fixed it

`TokenBucket._refill` added `elapsed * refill_rate` tokens with no upper bound. While a key
was busy, `elapsed` stayed small, so the bug was invisible. After a quiet period, `elapsed` was
huge and the bucket held thousands of tokens, which allowed a matching burst.

Fix: cap the refill at `capacity` inside `TokenBucket` (the root cause), not in `RateLimiter`.
Added a regression test that idles for an hour and checks the burst is exactly `capacity`.

## Stage 2: design of retry_after

## Stage 3: how eviction works and its cost

## How I used AI assistance (and what I checked myself)
