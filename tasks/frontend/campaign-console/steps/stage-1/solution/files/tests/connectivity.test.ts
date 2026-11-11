// The connectivity monitor against README "Connectivity", rules 1-4, on a fake clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectivityMonitor } from "../src/client/index.ts";
import { config } from "../src/index.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import type { ClientMessage, ProbeCause, ProbeResult } from "../src/index.ts";

const ID = "conn_twilio";

function setup(lastProbe?: Omit<ProbeResult, "connectionId" | "checkedAt">) {
  const scheduler = new FakeScheduler();
  const sent: ClientMessage[] = [];
  const changes: string[] = [];
  const monitor = createConnectivityMonitor({
    config: config.connectivity,
    send: (m) => sent.push(m),
    scheduler,
    onChange: (_id, status) => changes.push(status),
  });
  monitor.handle({
    type: "snapshot",
    state: {
      connections: {
        [ID]: {
          id: ID,
          platform: "twilio",
          method: "api_key",
          label: "Twilio",
          accountName: "Acme SMS",
          public: { method: "api_key", accountSid: "AC1", apiKeySid: "SK1" },
          ...(lastProbe ? { lastProbe: { connectionId: ID, checkedAt: scheduler.now(), ...lastProbe } } : {}),
        },
      },
      campaigns: {},
      runs: {},
      events: {},
    },
  });
  const push = (cause?: ProbeCause) =>
    monitor.handle({
      type: "probe",
      result: cause ? { connectionId: ID, ok: false, cause, checkedAt: scheduler.now() } : { connectionId: ID, ok: true, checkedAt: scheduler.now() },
    });
  return { monitor, scheduler, sent, changes, push, status: () => monitor.statusOf(ID) };
}

test("unauthorized: Checking until confirmAttempts results, each check asked for confirmIntervalMs after the previous answer", () => {
  const m = setup();
  m.push("unauthorized");
  assert.equal(m.status(), "checking");
  m.scheduler.advance(1_999);
  assert.equal(m.sent.length, 0);
  m.scheduler.advance(1);
  assert.equal(m.sent.length, 1);
  m.scheduler.advance(500); // a slow answer
  m.push("unauthorized");
  m.scheduler.advance(1_999);
  assert.equal(m.sent.length, 1, "counted from the answer, not from the request");
  m.scheduler.advance(1);
  assert.equal(m.sent.length, 2);
  m.push("unauthorized");
  assert.equal(m.status(), "disconnected");
  m.scheduler.advance(300_000);
  assert.equal(m.sent.length, 2);
  assert.deepEqual(m.changes, ["checking", "disconnected"]);
});

test("a success ends the confirmation and resets the strikes", () => {
  const m = setup();
  m.push("unauthorized");
  m.scheduler.advance(2_000);
  m.push("unauthorized");
  m.scheduler.advance(2_000);
  m.push();
  assert.equal(m.status(), "connected");
  m.push("unauthorized");
  assert.equal(m.status(), "checking", "one strike, not three");
});

test("unreachable and rate_limited never lead to Disconnected, however many in a row", () => {
  const m = setup();
  for (let i = 0; i < 20; i++) {
    m.push(i % 2 ? "unreachable" : "rate_limited");
    assert.equal(m.status(), "checking");
    m.scheduler.advance(2_000);
  }
  assert.equal(m.sent.length, 20, "one check every confirmIntervalMs");
  m.push();
  assert.equal(m.status(), "connected");
});

test("circuit_open is Paused, cancels a pending check and asks for none", () => {
  const m = setup();
  m.push("unauthorized");
  m.push("circuit_open");
  assert.equal(m.status(), "paused");
  m.scheduler.advance(600_000);
  assert.equal(m.sent.length, 0);
  assert.equal(m.scheduler.pending, 0);
});

test("Disconnected only leaves through a success or an open circuit", () => {
  const m = setup();
  for (let i = 0; i < 3; i++) {
    m.push("unauthorized");
    m.scheduler.advance(2_000);
  }
  assert.equal(m.status(), "disconnected");
  m.push("unreachable");
  m.push("unauthorized");
  assert.equal(m.status(), "disconnected");
  assert.equal(m.scheduler.pending, 0);
  m.push("circuit_open");
  assert.equal(m.status(), "paused");
});

test("page load: a failed lastProbe is strike one, confirmed confirmIntervalMs later", () => {
  const m = setup({ ok: false, cause: "unauthorized" });
  assert.equal(m.status(), "checking");
  assert.deepEqual(m.changes, [], "the first status is not a change");
  m.scheduler.advance(2_000);
  assert.deepEqual(m.sent, [{ type: "probe", connectionId: ID }]);
  m.push("unauthorized");
  m.scheduler.advance(2_000);
  m.push("unauthorized");
  assert.equal(m.status(), "disconnected");
});

test("a later snapshot doesn't count a result twice (the client resyncs after run changes)", () => {
  const m = setup();
  m.push("unauthorized");
  const resync = {
    type: "snapshot" as const,
    state: {
      connections: {
        [ID]: {
          id: ID,
          platform: "twilio" as const,
          method: "api_key" as const,
          label: "Twilio",
          accountName: "Acme SMS",
          public: { method: "api_key" as const, accountSid: "AC1", apiKeySid: "SK1" },
          lastProbe: { connectionId: ID, ok: false, cause: "unauthorized" as const, checkedAt: m.scheduler.now() },
        },
      },
      campaigns: {},
      runs: {},
      events: {},
    },
  };
  m.monitor.handle(resync);
  m.monitor.handle(resync);
  assert.equal(m.status(), "checking");
  m.scheduler.advance(2_000);
  m.push("unauthorized");
  assert.equal(m.status(), "checking", "two strikes so far, not four");
});

test("stop() cancels every pending check", () => {
  const m = setup();
  m.push("rate_limited");
  m.monitor.stop();
  assert.equal(m.scheduler.pending, 0);
});
