import random
import time

import pytest

from ratelimiter import FakeClock, RateLimiter

CAP, RATE = 5, 2.0
FULL = CAP / RATE


class NeverEvictingLimiter:
    """Reference model. All test values are exact binary fractions, so no float tolerance is needed."""

    def __init__(self, capacity, rate, clock):
        self.capacity, self.rate, self.clock = capacity, rate, clock
        self.state = {}

    def _tokens(self, key):
        now = self.clock.now()
        tokens, last = self.state.get(key, (self.capacity, now))
        return min(self.capacity, tokens + (now - last) * self.rate), now

    def allow(self, key, cost=1):
        tokens, now = self._tokens(key)
        ok = tokens >= cost
        self.state[key] = (tokens - cost if ok else tokens, now)
        return ok

    def retry_after(self, key, cost=1):
        tokens, _ = self._tokens(key)
        return max(0.0, (cost - tokens) / self.rate)


def test_idle_keys_are_evicted():
    clock = FakeClock()
    limiter = RateLimiter(CAP, RATE, clock)
    for i in range(10_000):
        limiter.allow(f"ip-{i}")
    assert len(limiter) == 10_000
    clock.advance(FULL + 0.001)
    limiter.allow("someone-new")
    assert len(limiter) == 1


def test_eviction_also_happens_on_retry_after():
    clock = FakeClock()
    limiter = RateLimiter(CAP, RATE, clock)
    for i in range(100):
        limiter.allow(f"ip-{i}")
    clock.advance(FULL + 0.001)
    limiter.retry_after("ip-0")
    assert len(limiter) <= 1


def test_recently_used_keys_are_kept():
    clock = FakeClock()
    limiter = RateLimiter(CAP, RATE, clock)
    for _ in range(CAP):
        limiter.allow("busy")
    clock.advance(FULL / 2)
    limiter.allow("other")
    assert not limiter.allow("busy", 3)
    assert limiter.allow("busy", 2)


def test_behaviour_matches_never_evicting_limiter():
    rng = random.Random(1234)
    clock = FakeClock()
    limiter = RateLimiter(CAP, RATE, clock)
    ref = NeverEvictingLimiter(CAP, RATE, clock)
    keys = [f"k{i}" for i in range(30)]
    for step in range(20_000):
        op = rng.random()
        key = rng.choice(keys)
        cost = rng.choice([1, 1, 1, 2, 0.5, 5])
        if op < 0.6:
            assert limiter.allow(key, cost) == ref.allow(key, cost), f"allow differs at step {step}"
        elif op < 0.8:
            expected = ref.retry_after(key, cost)
            assert limiter.retry_after(key, cost) == pytest.approx(expected, abs=1e-6), f"step {step}"
        else:
            clock.advance(rng.choice([0.125, 0.25, 0.5, 1.0, FULL, FULL * 3]))


def test_allow_is_amortized_constant_time():
    clock = FakeClock()
    limiter = RateLimiter(CAP, RATE, clock)
    n, budget = 200_000, 5.0
    start = time.perf_counter()
    for i in range(n):
        limiter.allow(f"ip-{i}")
        if i % 1000 == 0:
            clock.advance(0.125)
            if time.perf_counter() - start > budget:
                pytest.fail(f"allow() too slow: only {i} of {n} calls finished in {budget}s")
    assert len(limiter) < n
