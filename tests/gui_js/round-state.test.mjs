import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialRoundState as initial, jobName, roundReducer as reduce,
} from "../../src/interviewbench/ui/static/js/views/round/round-state.js";

const round = { id: "r", stage: 1, git: true, last: { test: null, grade: null, break: null } };
const loaded = reduce(initial, { type: "loaded", round });

test("starting a job clears what it would replace, and nothing else", () => {
  const state = { ...loaded, recent: { id: "old" }, failures: { test: "x", grade: "y", lost: "z", start: "w" } };
  const next = reduce(state, { type: "job-started", job: { id: "1", kind: "test" } });
  assert.equal(next.job.id, "1");
  assert.equal(next.recent, null);
  assert.deepEqual(next.failures, { grade: "y" });
});

test("a finished job files its result", () => {
  const running = reduce(loaded, { type: "job-started", job: { id: "1", kind: "judge-reply" } });
  const job = { id: "1", kind: "judge-reply", state: "succeeded", result: { percent: 80 } };
  const next = reduce(running, { type: "job-ended", job });
  assert.equal(next.job, null);
  assert.equal(next.recent, job);
  assert.deepEqual(next.round.last.grade, { percent: 80 });
  assert.equal(loaded.round.last.grade, null, "the old state stays as it was");
});

test("a failed job is remembered by kind", () => {
  const next = reduce(loaded, { type: "job-ended", job: { id: "1", kind: "break", state: "failed", error: "boom" } });
  assert.equal(next.failures.break, "boom");
  assert.equal(next.round.last.break, null);
  const silent = reduce(loaded, { type: "job-ended", job: { id: "2", kind: "test", state: "failed", error: null } });
  assert.equal(silent.failures.test, "It stopped without saying why.");
});

test("a job the server forgot says so", () => {
  const next = reduce(loaded, { type: "job-ended", job: null });
  assert.match(next.failures.lost, /lost track/);
  assert.equal(next.recent, null);
});

test("a job of an unknown kind finishes without filing anything", () => {
  const next = reduce(loaded, { type: "job-ended", job: { id: "1", state: "succeeded", result: {} } });
  assert.deepEqual(next.round, round);
  assert.equal(jobName(undefined), "Job");
});

test("switching panels drops only a failed start", () => {
  const state = reduce({ ...loaded, failures: { grade: "y" } }, { type: "start-failed", message: "no" });
  assert.deepEqual(reduce(state, { type: "panel-changed" }).failures, { grade: "y" });
});

test("moving on says what happened to the work", () => {
  const tagged = reduce(loaded, { type: "moved-on", round: { ...round, stage: 2, tagged: "stage-1" } });
  assert.equal(tagged.round.stage, 2);
  assert.equal("tagged" in tagged.round, false);
  assert.deepEqual(tagged.revealed, { stage: 2, message: "Stage 2 revealed. Your stage 1 work is committed and tagged stage-1." });
  const empty = reduce(loaded, { type: "moved-on", round: { ...round, stage: 2, tagged: null } });
  assert.match(empty.revealed.message, /nothing new to commit/);
  const noGit = reduce(loaded, { type: "moved-on", round: { ...round, stage: 2, git: false, tagged: null } });
  assert.equal(noGit.revealed.message, "Stage 2 revealed.");
});

test("unknown actions are a bug", () => {
  assert.throws(() => reduce(loaded, { type: "nope" }));
});
