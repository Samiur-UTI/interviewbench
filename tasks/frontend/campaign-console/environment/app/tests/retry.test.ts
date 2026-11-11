import assert from "node:assert/strict";
import { test } from "node:test";
import { PlatformError, backoffDelay, withRetry } from "../src/index.ts";

const base = { attempts: 4, baseMs: 500, maxMs: 8_000 };

test("backoff grows exponentially, is capped, and is fully jittered", () => {
  const top = (attempt: number) => backoffDelay(attempt, { ...base, maxMs: 3_000, random: () => 0.999999 });
  assert.deepEqual([1, 2, 3, 4].map(top), [499, 999, 1999, 2999]);
  assert.equal(backoffDelay(3, { ...base, random: () => 0 }), 0);
});

test("retries transient failures and returns the first success", async () => {
  const waits: number[] = [];
  let calls = 0;
  const value = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new PlatformError("unreachable", "timeout");
      return "ok";
    },
    { ...base, random: () => 0.5, sleep: async (ms) => void waits.push(ms), shouldRetry: () => true },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
});

test("gives up after the last attempt and rethrows its error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async (attempt) => {
        calls += 1;
        throw new PlatformError("rate_limited", `attempt ${attempt}`);
      },
      { ...base, random: () => 0, sleep: async () => {}, shouldRetry: () => true },
    ),
    { message: "attempt 4" },
  );
  assert.equal(calls, 4);
});

test("does not retry what shouldRetry refuses", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new PlatformError("unauthorized", "401");
      },
      {
        ...base,
        random: () => 0,
        sleep: async () => {},
        shouldRetry: (error) => error instanceof PlatformError && error.cause !== "unauthorized",
      },
    ),
    PlatformError,
  );
  assert.equal(calls, 1);
});
