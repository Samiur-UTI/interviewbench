// Stage 2, both halves, end to end: createApp with fake platforms, a real WebSocket, and the app's
// own createDashboardClient wired to it on the SAME fake scheduler, reconnecting through its real
// fetch against the server (helpers/stack.ts). Every wait is "the next message of this kind within
// 2 s real time"; the fake clock only moves between those waits.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadRender } from "./helpers/app.ts";
import { leaks } from "./helpers/browser.ts";
import { elements, textOf } from "./helpers/markup.ts";
import { NEW, NEW_SECRETS, acceptOnly, twilioBody, within } from "./helpers/reconnect.ts";
import { SECRETS, buildSeed, makeRun } from "./helpers/seed.ts";
import { createStack, runUntilSettled } from "./helpers/stack.ts";
import type { Stack } from "./helpers/stack.ts";

const stacks: Stack[] = [];
after(async () => {
  for (const s of stacks) await s.close();
});

test("a user reconnects a Twilio key that died mid-campaign from the dashboard: the card ends Connected, the run resumes where it stopped and says so, and no message goes out twice", async () => {
  const s = await createStack({ seed: buildSeed({ runs: [makeRun({ id: "run_t", platform: "twilio", items: 5, status: "running" })] }) });
  stacks.push(s);
  const sends = acceptOnly(s.fakes.twilio, [SECRETS.twilioApiKeySecret], { revokeAfter: 2 });
  const dash = await s.dashboard();
  const runStatuses: string[] = [];
  dash.ws.subscribe((m) => {
    if (m?.type === "run" && m.run?.id === "run_t" && runStatuses.at(-1) !== m.run.status) runStatuses.push(m.run.status);
  });

  // The key is deleted after two messages: the run pauses at the third.
  const started = await runUntilSettled(s.server.runner.start("run_t"), s.scheduler);
  assert.equal(started.error, undefined, String(started.error));
  await dash.ws.next((m) => m?.type === "run" && m.run?.id === "run_t" && m.run.status === "paused");
  await dash.settle();
  assert.equal(dash.client.state().runs.run_t?.status, "paused");
  assert.equal(dash.client.state().runs.run_t?.progress?.nextIndex, 2);

  // The card confirms the dead key the usual way (three checks, 2 s apart) and offers Reconnect.
  dash.ws.send({ type: "probe", connectionId: "conn_twilio" });
  await dash.nextProbe("conn_twilio");
  for (let i = 0; i < 2; i++) {
    await s.scheduler.advance(2_000);
    await dash.nextProbe("conn_twilio");
  }
  assert.equal(dash.status("conn_twilio"), "disconnected");

  // The user pastes the new key into the form; the dashboard client posts it.
  sends.allow(NEW.twilioApiKeySecret);
  const outcome = await within(dash.client.reconnect("conn_twilio", twilioBody()), 2_000, "reconnect()");
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.resumed, ["run_t"]);
  assert.equal(outcome.probe?.ok, true);
  assert.equal(dash.status("conn_twilio"), "connected", "Connected once the answer is in");

  await dash.ws.next((m) => m?.type === "run" && m.run?.id === "run_t" && m.run.status === "completed");
  await dash.settle();

  assert.deepEqual(
    sends.accepted,
    ["run_t_item_1", "run_t_item_2", "run_t_item_3", "run_t_item_4", "run_t_item_5"],
    "every message exactly once, the rejected one included, in order",
  );
  const pausedAt = runStatuses.indexOf("paused");
  assert.ok(pausedAt >= 0 && runStatuses.indexOf("running", pausedAt) > pausedAt, `run statuses seen: ${runStatuses.join(" -> ")}`);
  const state = dash.client.state();
  assert.equal(state.runs.run_t.status, "completed");
  assert.deepEqual(state.runs.run_t.progress, { nextIndex: 5, sent: 5, total: 5 });
  assert.equal(state.connections.conn_twilio.public.apiKeySid, NEW.twilioApiKeySid, "the card shows the new key");
  assert.equal(dash.status("conn_twilio"), "connected");

  const { renderToString } = await loadRender();
  const markup = renderToString(s.client.html`<${s.client.Dashboard} state=${state} statusOf=${dash.client.statusOf} />`);
  const regions = elements(markup).filter((e) => e.attrs.role === "status");
  assert.ok(regions.length > 0, 'a role="status" live region');
  assert.match(regions.map((e) => textOf(markup, e)).join(" | "), /resumed/i, "the live region announces the resume");

  assert.deepEqual(leaks(dash.ws.messages, [...s.secrets(), ...NEW_SECRETS]), [], "no secret in any live message");
});
