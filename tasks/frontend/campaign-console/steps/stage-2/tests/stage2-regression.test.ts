// Stage 2 regressions from stage 1: the monitor's confirmation timeline (README "Connectivity")
// and secrets after a credential is rejected mid-campaign (README rule 2), now that the run pauses.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadClient } from "./helpers/app.ts";
import { leaks } from "./helpers/browser.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import { NOW, buildSeed, makeRun } from "./helpers/seed.ts";
import { createStack, runUntilSettled } from "./helpers/stack.ts";
import type { Stack } from "./helpers/stack.ts";

const stacks: Stack[] = [];
after(async () => {
  for (const s of stacks) await s.close();
});

test("still: a rejected credential shows Checking, and Disconnected only after two more checks, each asked for 2 s after the previous answer", async () => {
  const client = await loadClient();
  const scheduler = new FakeScheduler(NOW);
  const sent: any[] = [];
  const monitor = client.createConnectivityMonitor({
    config: { probeIntervalMs: 60_000, confirmIntervalMs: 2_000, confirmAttempts: 3 },
    send: (m: unknown) => sent.push(m),
    scheduler,
  });
  const connection = {
    id: "conn_twilio",
    platform: "twilio",
    method: "api_key",
    label: "Twilio",
    accountName: "Test SMS",
    public: { method: "api_key", accountSid: "AC1", apiKeySid: "SK1" },
  };
  monitor.handle({ type: "snapshot", state: { connections: { conn_twilio: connection }, campaigns: {}, runs: {}, events: {} } });
  const reject = () => monitor.handle({ type: "probe", result: { connectionId: "conn_twilio", ok: false, cause: "unauthorized", checkedAt: scheduler.now() } });

  reject(); // t = 0
  assert.equal(monitor.statusOf("conn_twilio"), "checking");
  assert.equal(sent.length, 0);
  await scheduler.advance(2_000);
  assert.deepEqual(sent, [{ type: "probe", connectionId: "conn_twilio" }], "one check at t = 2000");
  await scheduler.advance(500); // answered late, at t = 2500
  reject();
  assert.equal(monitor.statusOf("conn_twilio"), "checking");
  await scheduler.advance(1_999);
  assert.equal(sent.length, 1, "the next check is counted from the answer");
  await scheduler.advance(1); // t = 4500
  assert.equal(sent.length, 2);
  reject();
  assert.equal(monitor.statusOf("conn_twilio"), "disconnected");
  await scheduler.advance(120_000);
  assert.equal(sent.length, 2, "no more checks once Disconnected");
  monitor.stop();
});

test("still: after Google rejects a credential mid-campaign, no page, API or live message carries a token, not even the rotated one", async () => {
  const run = makeRun({ id: "run_g", platform: "google", items: 2, status: "running" });
  const s = await createStack({ seed: buildSeed({ runs: [run] }) });
  stacks.push(s);
  const dash = await s.dashboard();
  s.fakes.google.script("send", "unauthorized", "unauthorized"); // fails, forced refresh, fails again

  const settled = await runUntilSettled(s.server.runner.start("run_g"), s.scheduler);
  assert.equal(settled.error, undefined, String(settled.error));
  assert.equal(s.fakes.google.issued.length, 1, "the runner refreshed the token once (so the old one was rotated)");
  await dash.ws.next((m) => m?.type === "event" && (m.event?.type === "paused" || m.event?.type === "failed"));
  dash.ws.send({ type: "probe", connectionId: "conn_google" });
  await dash.nextProbe("conn_google");
  await dash.settle();

  const page = await (await fetch(`${s.url}/dashboard`)).text();
  const api = await (await fetch(`${s.url}/api/dashboard`)).text();
  assert.deepEqual(leaks(dash.ws.messages, s.secrets()), [], `live messages: ${dash.ws.messages.map((m) => m.type).join(",")}`);
  assert.deepEqual(leaks(page, s.secrets()), [], "page");
  assert.deepEqual(leaks(api, s.secrets()), [], "/api/dashboard");
});
