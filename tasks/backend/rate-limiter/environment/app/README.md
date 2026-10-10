# ratelimiter

In-process, per-key token-bucket rate limiting.

```python
from ratelimiter import RateLimiter

limiter = RateLimiter(capacity=5, refill_rate=1.0)  # burst of 5, then 1 request/second
if not limiter.allow("api-key-123"):
    return 429
```

- `TokenBucket` (`ratelimiter/bucket.py`): a single bucket.
- `RateLimiter` (`ratelimiter/limiter.py`): one bucket per key.
- `FakeClock` (`ratelimiter/clock.py`): a controllable clock for tests; never `sleep` in tests.

Run the tests with `python -m pytest`.
