from ratelimiter import FakeClock, RateLimiter, TokenBucket


def test_burst_after_idle_is_capped_at_capacity():
    clock = FakeClock()
    bucket = TokenBucket(capacity=5, refill_rate=1, clock=clock)
    clock.advance(3600)
    assert sum(bucket.allow() for _ in range(100)) == 5


def test_tokens_never_exceed_capacity():
    clock = FakeClock()
    bucket = TokenBucket(capacity=5, refill_rate=2, clock=clock)
    bucket.allow()
    clock.advance(1000)
    assert bucket.tokens == 5


def test_partial_refill_still_accumulates():
    clock = FakeClock()
    bucket = TokenBucket(capacity=2, refill_rate=1, clock=clock)
    bucket.allow()
    bucket.allow()
    clock.advance(0.5)
    assert not bucket.allow()
    clock.advance(0.5)
    assert bucket.allow()


def test_limiter_burst_after_idle_is_capped():
    clock = FakeClock()
    limiter = RateLimiter(capacity=5, refill_rate=1, clock=clock)
    assert limiter.allow("k")
    clock.advance(86400)
    assert sum(limiter.allow("k") for _ in range(50)) == 5
