import pytest

from ratelimiter import FakeClock, RateLimiter, TokenBucket


def test_burst_up_to_capacity_then_denied():
    bucket = TokenBucket(capacity=3, refill_rate=1, clock=FakeClock())
    assert [bucket.allow() for _ in range(4)] == [True, True, True, False]


def test_refills_over_time():
    clock = FakeClock()
    bucket = TokenBucket(capacity=3, refill_rate=1, clock=clock)
    for _ in range(3):
        bucket.allow()
    clock.advance(1)
    assert bucket.allow()
    assert not bucket.allow()


def test_rejects_invalid_config():
    with pytest.raises(ValueError):
        TokenBucket(capacity=0, refill_rate=1)


def test_keys_are_independent():
    limiter = RateLimiter(capacity=1, refill_rate=1, clock=FakeClock())
    assert limiter.allow("a")
    assert not limiter.allow("a")
    assert limiter.allow("b")


def test_regression_burst_after_idle_is_capped():
    clock = FakeClock()
    bucket = TokenBucket(capacity=5, refill_rate=1, clock=clock)
    clock.advance(3600)
    assert sum(bucket.allow() for _ in range(20)) == 5


def test_retry_after_then_allow():
    clock = FakeClock()
    limiter = RateLimiter(capacity=2, refill_rate=4, clock=clock)
    limiter.allow("k", 2)
    wait = limiter.retry_after("k", 1.5)
    assert wait == pytest.approx(0.375)
    clock.advance(wait)
    assert limiter.allow("k", 1.5)


@pytest.mark.parametrize("cost", [0, -2, 3])
def test_invalid_cost(cost):
    limiter = RateLimiter(capacity=2, refill_rate=1, clock=FakeClock())
    with pytest.raises(ValueError):
        limiter.allow("k", cost)
    with pytest.raises(ValueError):
        limiter.retry_after("k", cost)


def test_idle_keys_are_evicted_but_busy_keys_kept():
    clock = FakeClock()
    limiter = RateLimiter(capacity=2, refill_rate=1, clock=clock)
    limiter.allow("idle")
    clock.advance(1)
    limiter.allow("busy", 2)
    clock.advance(1.5)
    limiter.allow("new")
    assert len(limiter) == 2
    assert not limiter.allow("busy", 2)
