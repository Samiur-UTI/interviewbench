from __future__ import annotations

from .bucket import TokenBucket
from .clock import Clock, SystemClock


class RateLimiter:
    """Per-key rate limiting: each key (API key, user id, IP...) gets its own TokenBucket."""

    def __init__(self, capacity: float, refill_rate: float, clock: Clock | None = None) -> None:
        self.capacity = capacity
        self.refill_rate = refill_rate
        self._clock = clock or SystemClock()
        self._buckets: dict[str, TokenBucket] = {}

    def allow(self, key: str, cost: float = 1) -> bool:
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = TokenBucket(self.capacity, self.refill_rate, self._clock)
            self._buckets[key] = bucket
        return bucket.allow(cost)

    def __len__(self) -> int:
        return len(self._buckets)
