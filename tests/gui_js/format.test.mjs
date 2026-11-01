import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countdown, describeTimeLeft, formatClock, formatElapsed, formatPercent, formatPoints, formatTimeOfDay,
  formatTokens, judgeProblem, parseTime, plural, timeMilestone, withoutTitle,
} from "../../src/interviewbench/ui/static/js/core/format.js";

const MIN = 60000;

test("parseTime reads Python's isoformat, with or without microseconds", () => {
  assert.equal(parseTime("2026-11-01T02:06:00.123456+00:00"), Date.UTC(2026, 10, 1, 2, 6, 0, 123));
  assert.equal(parseTime("2026-11-01T02:06:00+06:00"), Date.UTC(2026, 9, 31, 20, 6));
  assert.equal(parseTime("2026-11-01T02:06:00Z"), Date.UTC(2026, 10, 1, 2, 6));
});

test("parseTime takes epoch numbers and rejects nonsense", () => {
  assert.equal(parseTime(1700000000), 1700000000000);
  assert.equal(parseTime(1700000000000), 1700000000000);
  assert.equal(parseTime(null), null);
  assert.equal(parseTime(""), null);
  assert.equal(parseTime("soon"), null);
});

test("formatClock", () => {
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(59999), "00:59");
  assert.equal(formatClock(4 * MIN + 9000), "04:09");
  assert.equal(formatClock(64 * MIN + 9000), "1:04:09");
  assert.equal(formatClock(-5), "00:00");
});

test("formatElapsed", () => {
  assert.equal(formatElapsed(8000), "8s");
  assert.equal(formatElapsed(125000), "2m 05s");
  assert.equal(formatElapsed(63 * MIN), "1h 03m");
});

test("countdown runs, runs low, then goes calmly into overtime", () => {
  assert.deepEqual(countdown(60 * MIN, 0), { state: "running", text: "1:00:00", label: "left" });
  assert.equal(countdown(5 * MIN + 1000, 0).state, "running");
  assert.equal(countdown(5 * MIN, 0).state, "low");
  assert.equal(countdown(1, 0).text, "00:01");
  assert.deepEqual(countdown(0, 0), { state: "overtime", text: "+00:00", label: "over time" });
  assert.equal(countdown(0, 3 * MIN + 12000).text, "+03:12");
});

test("timeMilestone speaks once at each mark and at time up", () => {
  const ends = 60 * MIN;
  assert.equal(timeMilestone(ends, ends - 10 * MIN - 1, ends - 10 * MIN), "10 minutes left.");
  assert.equal(timeMilestone(ends, ends - 10 * MIN, ends - 10 * MIN + 1000), null);
  assert.equal(timeMilestone(ends, ends - MIN - 1, ends - MIN + 1), "1 minute left.");
  assert.match(timeMilestone(ends, ends - 1, ends + 1), /^Time is up/);
  assert.equal(timeMilestone(ends, ends + 1, ends + 2), null);
});

test("describeTimeLeft", () => {
  assert.equal(describeTimeLeft(12 * MIN, 0), "12 min left");
  assert.equal(describeTimeLeft(90 * MIN, 0), "1 h 30 min left");
  assert.equal(describeTimeLeft(120 * MIN, 0), "2 h left");
  assert.equal(describeTimeLeft(1000, 0), "1 min left");
  assert.equal(describeTimeLeft(0, 3 * MIN), "Over by 3 min");
});

test("formatTimeOfDay is a zero-padded 24-hour clock", () => {
  assert.equal(formatTimeOfDay(new Date(2026, 0, 2, 3, 4).getTime()), "03:04");
});

test("counts and points", () => {
  assert.equal(plural(1, "stage"), "1 stage");
  assert.equal(plural(0, "stage"), "0 stages");
  assert.equal(plural(2, "bad test"), "2 bad tests");
  assert.equal(formatPoints(15), "15");
  assert.equal(formatPoints(12.46), "12.5");
  assert.equal(formatPoints(null), "0");
  assert.equal(formatPercent(0.666), "67%");
  assert.equal(formatTokens(12345), "about 12,345 tokens");
});

test("judgeProblem says what's missing, and a local model needs no key", () => {
  const openai = { backend: "openai", base_url: "https://openrouter.ai/api/v1", model: "m", has_api_key: true };
  assert.equal(judgeProblem(openai), null);
  assert.match(judgeProblem({ ...openai, has_api_key: false }), /API key/);
  assert.match(judgeProblem({ ...openai, base_url: "" }), /API address/);
  assert.match(judgeProblem({ ...openai, model: "" }), /model/);
  assert.equal(judgeProblem({ ...openai, base_url: "http://localhost:11434/v1", has_api_key: false }), null);
  const claude = { backend: "claude", claude_sdk_installed: true, has_api_key: true };
  assert.equal(judgeProblem(claude), null);
  assert.match(judgeProblem({ ...claude, has_api_key: false }), /API key/);
  assert.match(judgeProblem({ ...claude, claude_sdk_installed: false }), /package/);
});

test("withoutTitle drops only a leading heading that repeats the stage title", () => {
  assert.equal(withoutTitle("# Fix the bug\n\nBody", "Fix the bug"), "Body");
  assert.equal(withoutTitle("Fix the bug\n\nBody", "Fix the bug"), "Body");
  assert.equal(withoutTitle("# Other\n\nBody", "Fix the bug"), "# Other\n\nBody");
  assert.equal(withoutTitle(null, "Fix the bug"), "");
});
