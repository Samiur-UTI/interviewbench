from __future__ import annotations

from .clock import Clock, SystemClock


class TokenBucket:
    """Allows bursts of up to `capacity` tokens, refilling at `refill_rate` tokens per second."""

    def __init__(self, capacity: float, refill_rate: float, clock: Clock | None = None) -> None:
        if capacity <= 0 or refill_rate <= 0:
            raise ValueError("capacity and refill_rate must be positive")
        self.capacity = capacity
        self.refill_rate = refill_rate
        self._clock = clock or SystemClock()
        self._tokens = float(capacity)
        self._last_refill = self._clock.now()

    @property
    def tokens(self) -> float:
        self._refill()
        return self._tokens

    def _refill(self) -> None:
        now = self._clock.now()
        elapsed = now - self._last_refill
        self._tokens = min(self.capacity, self._tokens + elapsed * self.refill_rate)
        self._last_refill = now

    def allow(self, cost: float = 1) -> bool:
        self._refill()
        if self._tokens >= cost:
            self._tokens -= cost
            return True
        return False
