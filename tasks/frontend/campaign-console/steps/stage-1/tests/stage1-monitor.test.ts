// Stage 1, browser half: the connectivity monitor alone (src/client/index.ts), on a fake clock,
// with a spy for what it sends. README "Connectivity", rules 1-4.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadClient } from "./helpers/app.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import { NOW } from "./helpers/seed.ts";

const CONFIG = { probeIntervalMs: 60_000, confirmIntervalMs: 2_000, confirmAttempts: 3 };
type Cause = "unauthorized" | "unreachable" | "rate_limited" | "circuit_open";

async function setup(config = CONFIG, lastProbes: Record<string, { ok: boolean; cause?: Cause } | undefined> = { conn_twilio: undefined }) {
  const client = await loadClient();
  const scheduler = new FakeScheduler(NOW);
  const sent: any[] = [];
  const seen: string[] = [];
  const monitor = client.createConnectivityMonitor({
    config,
    send: (m: unknown) => sent.push(m),
    scheduler,
    onChange: (id: string, status: string) => seen.push(`${id}:${status}`),
  });
  const connections: Record<string, any> = {};
  for (const [id, probe] of Object.entries(lastProbes)) {
    connections[id] = {
      id,
      platform: "twilio",
      method: "api_key",
      label: id,
      accountName: id,
      public: { method: "api_key", accountSid: "AC1", apiKeySid: "SK1" },
      ...(probe ? { lastProbe: { connectionId: id, checkedAt: NOW - 1_000, ...probe } } : {}),
    };
  }
  monitor.handle({ type: "snapshot", state: { connections, campaigns: {}, runs: {}, events: {} } });
  /** Pushes a probe result, as the server does, stamped with the current fake time. */
  const push = (cause: Cause | "ok", id = "conn_twilio") =>
    monitor.handle({
      type: "probe",
      result: cause === "ok" ? { connectionId: id, ok: true, checkedAt: scheduler.now() } : { connectionId: id, ok: false, cause, checkedAt: scheduler.now() },
    });
  const probesSent = (id = "conn_twilio") => sent.filter((m) => m?.type === "probe" && m.connectionId === id).length;
  return { monitor, scheduler, sent, seen, push, probesSent, status: (id = "conn_twilio") => monitor.statusOf(id) };
}

test("a rejected credential shows Checking, and Disconnected only after two more checks, each asked for 2 s after the previous answer", async () => {
  const m = await setup();
  m.push("unauthorized"); // t = 0
  assert.equal(m.status(), "checking");
  assert.equal(m.sent.length, 0, "nothing is sent with the first failure");
  await m.scheduler.advance(1_999);
  assert.equal(m.sent.length, 0, "no check before confirmIntervalMs");
  await m.scheduler.advance(1); // t = 2000
  assert.deepEqual(m.sent, [{ type: "probe", connectionId: "conn_twilio" }], "exactly one check at t = 2000");
  await m.scheduler.advance(500); // the answer is slow: t = 2500
  assert.equal(m.sent.length, 1, "no second check while the first is unanswered");
  m.push("unauthorized");
  assert.equal(m.status(), "checking", "two strikes are not enough");
  await m.scheduler.advance(1_999); // t = 4499
  assert.equal(m.sent.length, 1, "the next check is counted from the answer (t = 2500), not from the request");
  await m.scheduler.advance(1); // t = 4500
  assert.equal(m.sent.length, 2);
  m.push("unauthorized");
  assert.equal(m.status(), "disconnected");
  await m.scheduler.advance(120_000);
  assert.equal(m.sent.length, 2, "no more checks once Disconnected");
});

test("a check that succeeds during the confirmation shows Connected, stops the checks, and a later failure starts over", async () => {
  const m = await setup();
  m.push("unauthorized");
  await m.scheduler.advance(2_000);
  assert.equal(m.sent.length, 1);
  m.push("ok"); // answered at t = 2000
  assert.equal(m.status(), "connected");
  await m.scheduler.advance(180_000);
  assert.equal(m.sent.length, 1, "no check after a success");
  m.push("unauthorized");
  assert.equal(m.status(), "checking", "strikes start again from zero after a success");
  await m.scheduler.advance(2_000);
  m.push("unauthorized");
  assert.equal(m.status(), "checking");
});

test("a platform that is slow or throttling never shows Disconnected: the card keeps checking every 2 s until a check succeeds", async () => {
  const m = await setup();
  m.push("unreachable");
  assert.equal(m.status(), "checking");
  for (let i = 1; i <= 6; i++) {
    await m.scheduler.advance(2_000);
    assert.equal(m.probesSent(), i, `check ${i} asked for 2 s after the previous answer`);
    m.push(i % 2 === 0 ? "unreachable" : "rate_limited");
    assert.equal(m.status(), "checking", `after ${i + 1} transient failures`);
  }
  await m.scheduler.advance(2_000);
  m.push("ok");
  assert.equal(m.status(), "connected");
  assert.ok(!m.seen.some((s) => s.endsWith(":disconnected")), `statuses seen: ${m.seen.join(", ")}`);
});

test("a tripped circuit shows Paused, never Reconnect, and the card stops asking for checks until the next result arrives", async () => {
  const m = await setup();
  m.push("circuit_open");
  assert.equal(m.status(), "paused");
  await m.scheduler.advance(180_000);
  assert.equal(m.sent.length, 0, "no checks while paused");

  m.push("unauthorized"); // a confirmation in progress...
  assert.equal(m.status(), "checking");
  m.push("circuit_open"); // ...is cancelled by an open circuit
  assert.equal(m.status(), "paused");
  await m.scheduler.advance(10_000);
  assert.equal(m.sent.length, 0, "the pending check was cancelled");

  m.push("ok");
  assert.equal(m.status(), "connected");
  assert.ok(!m.seen.some((s) => s.endsWith(":disconnected")), `statuses seen: ${m.seen.join(", ")}`);
});

test("Disconnected stays until a check succeeds: further failures change nothing and ask for nothing", async () => {
  const m = await setup();
  m.push("unauthorized");
  for (let i = 0; i < 2; i++) {
    await m.scheduler.advance(2_000);
    m.push("unauthorized");
  }
  assert.equal(m.status(), "disconnected");
  const sent = m.sent.length;
  m.push("unauthorized");
  m.push("unreachable");
  m.push("rate_limited");
  assert.equal(m.status(), "disconnected");
  await m.scheduler.advance(120_000);
  assert.equal(m.sent.length, sent, "no checks while Disconnected (the server's own schedule brings the next result)");
  m.push("ok");
  assert.equal(m.status(), "connected");
});

test("on page load a failed last check counts as the first strike and is confirmed 2 s later; never-checked and healthy cards are Connected", async () => {
  const m = await setup(CONFIG, {
    conn_new: undefined,
    conn_ok: { ok: true },
    conn_rejected: { ok: false, cause: "unauthorized" },
    conn_slow: { ok: false, cause: "rate_limited" },
    conn_tripped: { ok: false, cause: "circuit_open" },
  });
  assert.deepEqual(
    ["conn_new", "conn_ok", "conn_rejected", "conn_slow", "conn_tripped"].map((id) => m.status(id)),
    ["connected", "connected", "checking", "checking", "paused"],
  );
  assert.throws(() => m.monitor.statusOf("conn_unknown"), RangeError);
  await m.scheduler.advance(1_999);
  assert.equal(m.sent.length, 0);
  await m.scheduler.advance(1);
  assert.deepEqual(m.sent.map((s) => s.connectionId).sort(), ["conn_rejected", "conn_slow"], "one check each for the failed cards, 2 s after load");
  m.push("unauthorized", "conn_rejected"); // strike 2
  assert.equal(m.status("conn_rejected"), "checking");
  await m.scheduler.advance(2_000);
  m.push("unauthorized", "conn_rejected"); // strike 3: the snapshot's result was strike 1
  assert.equal(m.status("conn_rejected"), "disconnected");
});

test("the monitor uses the confirmation numbers it is configured with, and stop() cancels every pending check", async () => {
  const m = await setup({ probeIntervalMs: 10_000, confirmIntervalMs: 500, confirmAttempts: 2 }, { conn_twilio: undefined, conn_meta: undefined });
  m.push("unauthorized");
  await m.scheduler.advance(499);
  assert.equal(m.probesSent(), 0);
  await m.scheduler.advance(1);
  assert.equal(m.probesSent(), 1);
  m.push("unauthorized");
  assert.equal(m.status(), "disconnected", "confirmAttempts = 2");

  m.push("unreachable", "conn_meta");
  assert.equal(m.status("conn_meta"), "checking");
  m.monitor.stop();
  assert.equal(m.scheduler.pending, 0, "no timer left after stop()");
  await m.scheduler.advance(60_000);
  assert.equal(m.probesSent("conn_meta"), 0);
});
