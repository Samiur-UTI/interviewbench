import assert from "node:assert/strict";
import { test } from "node:test";
import { CircuitBreaker, CircuitOpenError, PlatformError } from "../src/index.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";

const config = { failureThreshold: 3, openMs: 10_000 };
const fail = (cause: "unreachable" | "rate_limited" | "unauthorized") => async () => {
  throw new PlatformError(cause, cause);
};

async function failTimes(breaker: CircuitBreaker, id: string, n: number, cause: "unreachable" | "rate_limited" | "unauthorized" = "unreachable") {
  for (let i = 0; i < n; i++) await breaker.call(id, fail(cause)).catch(() => {});
}

test("opens after failureThreshold consecutive outages and short-circuits calls", async () => {
  const scheduler = new FakeScheduler();
  const breaker = new CircuitBreaker(scheduler, config);
  await failTimes(breaker, "conn_a", 3);
  assert.equal(breaker.state("conn_a"), "open");
  let called = false;
  await assert.rejects(
    breaker.call("conn_a", async () => {
      called = true;
    }),
    CircuitOpenError,
  );
  assert.equal(called, false);
  assert.equal(breaker.retryAt("conn_a"), scheduler.now() + 10_000);
});

test("circuits are per connection", async () => {
  const breaker = new CircuitBreaker(new FakeScheduler(), config);
  await failTimes(breaker, "conn_a", 3);
  assert.equal(breaker.state("conn_b"), "closed");
  assert.equal(await breaker.call("conn_b", async () => 42), 42);
});

test("a rejected credential never trips the breaker", async () => {
  const breaker = new CircuitBreaker(new FakeScheduler(), config);
  await failTimes(breaker, "conn_a", 10, "unauthorized");
  assert.equal(breaker.state("conn_a"), "closed");
});

test("a success resets the count", async () => {
  const breaker = new CircuitBreaker(new FakeScheduler(), config);
  await failTimes(breaker, "conn_a", 2);
  await breaker.call("conn_a", async () => {});
  await failTimes(breaker, "conn_a", 2);
  assert.equal(breaker.state("conn_a"), "closed");
});

test("after openMs one trial call decides: success closes, failure reopens", async () => {
  const scheduler = new FakeScheduler();
  const breaker = new CircuitBreaker(scheduler, config);
  await failTimes(breaker, "conn_a", 3);
  scheduler.advance(10_000);
  assert.equal(breaker.state("conn_a"), "half_open");
  await failTimes(breaker, "conn_a", 1);
  assert.equal(breaker.state("conn_a"), "open");
  scheduler.advance(10_000);
  await breaker.call("conn_a", async () => {});
  assert.equal(breaker.state("conn_a"), "closed");
});

test("reset closes the circuit", async () => {
  const breaker = new CircuitBreaker(new FakeScheduler(), config);
  await failTimes(breaker, "conn_a", 3);
  breaker.reset("conn_a");
  assert.equal(breaker.state("conn_a"), "closed");
});
