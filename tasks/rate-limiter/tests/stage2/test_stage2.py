import pytest

from ratelimiter import FakeClock, RateLimiter


def make(capacity=5, rate=1.0):
    clock = FakeClock()
    return clock, RateLimiter(capacity=capacity, refill_rate=rate, clock=clock)


def drain(limiter, key, n):
    for _ in range(n):
        assert limiter.allow(key)


def test_retry_after_is_zero_when_allowed():
    _, limiter = make()
    assert limiter.retry_after("new") == 0.0
    limiter.allow("k")
    assert limiter.retry_after("k") == 0.0


def test_retry_after_when_empty():
    _, limiter = make(capacity=5, rate=2.0)
    drain(limiter, "k", 5)
    assert limiter.retry_after("k") == pytest.approx(0.5)
    assert limiter.retry_after("k", cost=3) == pytest.approx(1.5)


def test_retry_after_accounts_for_partial_refill():
    clock, limiter = make(capacity=5, rate=1.0)
    drain(limiter, "k", 5)
    clock.advance(0.25)
    assert limiter.retry_after("k") == pytest.approx(0.75)


def test_retry_after_does_not_consume_tokens():
    _, limiter = make(capacity=3)
    for _ in range(10):
        limiter.retry_after("k")
    drain(limiter, "k", 3)
    assert not limiter.allow("k")


def test_waiting_retry_after_then_allow_succeeds():
    clock, limiter = make(capacity=4, rate=3.0)
    drain(limiter, "k", 4)
    for cost in (1, 2.5, 4, 0.7):
        wait = limiter.retry_after("k", cost)
        assert wait > 0
        clock.advance(wait)
        assert limiter.allow("k", cost)


@pytest.mark.parametrize("cost", [0, -1, 5.01, 100])
def test_invalid_costs_raise(cost):
    _, limiter = make(capacity=5)
    with pytest.raises(ValueError):
        limiter.allow("k", cost)
    with pytest.raises(ValueError):
        limiter.retry_after("k", cost)


def test_cost_equal_to_capacity_is_valid():
    _, limiter = make(capacity=5)
    assert limiter.allow("k", 5)
    assert limiter.retry_after("k", 5) == pytest.approx(5.0)
