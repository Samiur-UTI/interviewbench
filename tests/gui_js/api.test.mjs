import assert from "node:assert/strict";
import { test } from "node:test";

import { followJob } from "../../src/interviewbench/ui/static/js/core/api.js";

// Answers each poll from a list. A number is that HTTP status, null a dropped connection, else a job.
function serve(answers) {
  const calls = { count: 0 };
  globalThis.fetch = async () => {
    const answer = answers[Math.min(calls.count, answers.length - 1)];
    calls.count += 1;
    if (answer === null) throw new TypeError("network down");
    const status = typeof answer === "number" ? answer : 200;
    const body = status === 200 ? answer : { error: { code: "nope", message: "no" } };
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
}

const running = { state: "running", phase: "one" };
const finished = { state: "succeeded", phase: "two" };

test("reports each poll and returns the finished job", async () => {
  serve([running, finished]);
  const seen = [];
  assert.equal((await followJob("1", (job) => seen.push(job.phase))).state, "succeeded");
  assert.deepEqual(seen, ["one", "two"]);
});

test("a dropped connection is retried", async () => {
  const calls = serve([null, finished]);
  assert.equal((await followJob("1", () => {})).state, "succeeded");
  assert.equal(calls.count, 2);
});

test("a job the server can't give back ends the follow instead of spinning for ever", async () => {
  for (const status of [404, 403, 500]) {
    const calls = serve([status]);
    assert.equal(await followJob("1", () => {}), null, String(status));
    assert.equal(calls.count, 1, String(status));
  }
});

test("a 401 goes to the caller", async () => {
  serve([401]);
  await assert.rejects(followJob("1", () => {}), (err) => err.status === 401);
});

test("a bug in the callback surfaces instead of being retried", async () => {
  const calls = serve([running]);
  await assert.rejects(followJob("1", () => {
    throw new TypeError("a bug");
  }), TypeError);
  assert.equal(calls.count, 1);
});

test("abort stops the wait and leaves no listener behind", async () => {
  serve([running]);
  const controller = new AbortController();
  const added = [];
  const removed = [];
  const { addEventListener: add, removeEventListener: remove } = controller.signal;
  controller.signal.addEventListener = function listen(type, fn, options) {
    added.push(fn);
    add.call(this, type, fn, options);
  };
  controller.signal.removeEventListener = function unlisten(type, fn, options) {
    removed.push(fn);
    remove.call(this, type, fn, options);
  };
  const done = followJob("1", () => controller.abort(), controller.signal);
  assert.equal(await done, null);
  assert.deepEqual(removed, added);
});
