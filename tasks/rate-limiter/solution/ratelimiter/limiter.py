from __future__ import annotations

from collections import OrderedDict

from .bucket import TokenBucket
from .clock import Clock, SystemClock


class RateLimiter:
    """Per-key rate limiting: each key (API key, user id, IP...) gets its own TokenBucket.

    Keys are kept in least-recently-allowed order. A key idle for capacity / refill_rate
    seconds has a full bucket, which is indistinguishable from a new one, so it is evicted.
    """

    def __init__(self, capacity: float, refill_rate: float, clock: Clock | None = None) -> None:
        if capacity <= 0 or refill_rate <= 0:
            raise ValueError("capacity and refill_rate must be positive")
        self.capacity = capacity
        self.refill_rate = refill_rate
        self._clock = clock or SystemClock()
        self._full_after = capacity / refill_rate
        self._buckets: OrderedDict[str, tuple[TokenBucket, float]] = OrderedDict()

    def _evict_idle(self, now: float) -> None:
        while self._buckets:
            _, (_, last_used) = next(iter(self._buckets.items()))
            if now - last_used < self._full_after:
                break
            self._buckets.popitem(last=False)

    def _new_bucket(self) -> TokenBucket:
        return TokenBucket(self.capacity, self.refill_rate, self._clock)

    def allow(self, key: str, cost: float = 1) -> bool:
        now = self._clock.now()
        self._evict_idle(now)
        entry = self._buckets.get(key)
        bucket = entry[0] if entry else self._new_bucket()
        allowed = bucket.allow(cost)
        self._buckets[key] = (bucket, now)
        self._buckets.move_to_end(key)
        return allowed

    def retry_after(self, key: str, cost: float = 1) -> float:
        self._evict_idle(self._clock.now())
        entry = self._buckets.get(key)
        bucket = entry[0] if entry else self._new_bucket()
        return bucket.time_until(cost)

    def __len__(self) -> int:
        return len(self._buckets)
