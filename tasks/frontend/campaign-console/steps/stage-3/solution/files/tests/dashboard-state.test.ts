import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState, reduce } from "../src/client/index.ts";
import type { DashboardState, PublicEvent, PublicRun } from "../src/shared/types.ts";

function state(): DashboardState {
  const run: PublicRun = {
    id: "run_1",
    campaignId: "camp_1",
    connectionId: "conn_twilio",
    status: "running",
    progress: { nextIndex: 1, sent: 1, total: 3 },
    startedAt: 1,
    updatedAt: 1,
    eventCount: 1,
  };
  return {
    connections: {
      conn_twilio: {
        id: "conn_twilio",
        platform: "twilio",
        method: "api_key",
        label: "Twilio",
        accountName: "Acme SMS",
        public: { method: "api_key", accountSid: "AC123", apiKeySid: "SK123" },
      },
    },
    campaigns: {},
    runs: { run_1: run },
    events: { run_1: [{ id: 1, runId: "run_1", at: 1, type: "sent", message: "sent" }] },
  };
}

test("a snapshot replaces the state", () => {
  const next = reduce(initialState, { type: "snapshot", state: state() });
  assert.deepEqual(next, state());
});

test("a probe result is stored on its connection", () => {
  const result = { connectionId: "conn_twilio", ok: false, cause: "unreachable" as const, checkedAt: 5 };
  const next = reduce(state(), { type: "probe", result });
  assert.deepEqual(next.connections.conn_twilio.lastProbe, result);
});

test("a probe result for an unknown connection changes nothing", () => {
  const before = state();
  const next = reduce(before, { type: "probe", result: { connectionId: "conn_x", ok: true, checkedAt: 5 } });
  assert.equal(next, before);
});

test("run updates replace the run without touching the previous state", () => {
  const before = state();
  const run = { ...before.runs.run_1, status: "completed" as const, progress: { nextIndex: 3, sent: 3, total: 3 } };
  const next = reduce(before, { type: "run", run });
  assert.equal(next.runs.run_1.status, "completed");
  assert.equal(before.runs.run_1.status, "running");
});

test("events are appended once, in order", () => {
  const event: PublicEvent = { id: 2, runId: "run_1", at: 2, type: "sent", message: "sent again" };
  const once = reduce(state(), { type: "event", runId: "run_1", event });
  const twice = reduce(once, { type: "event", runId: "run_1", event });
  assert.deepEqual(
    twice.events.run_1.map((e) => e.id),
    [1, 2],
  );
});
