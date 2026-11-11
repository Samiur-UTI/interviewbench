// Stage 3 regressions: stage 1's confirmation timeline, now that checks come from one shared
// schedule; stage 2's reconnect-and-resume on a run longer than the recent events; and README
// rule 2 (no secret reaches the browser) on the numbered messages and the new events API.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadRender } from "./helpers/app.ts";
import { leaks, parseState } from "./helpers/browser.ts";
import { elements, textOf } from "./helpers/markup.ts";
import { NEW, NEW_SECRETS, acceptOnly, twilioBody, within } from "./helpers/reconnect.ts";
import { SECRETS, buildSeed, makeRun, storedDiagnosticsEvent } from "./helpers/seed.ts";
import { createStack, runUntilSettled } from "./helpers/stack.ts";
import type { Stack } from "./helpers/stack.ts";

const stacks: Stack[] = [];
after(async () => {
  for (const s of stacks) await s.close();
});
async function stack(seed: any): Promise<Stack> {
  const s = await createStack({ seed });
  stacks.push(s);
  return s;
}

const liveRegion = (markup: string) =>
  elements(markup)
    .filter((e) => e.attrs.role === "status")
    .map((e) => textOf(markup, e))
    .join(" | ");

test("still: a key that dies between checks shows Disconnected after the schedule's check and two confirming checks 2 s apart, each one platform call made at once", async () => {
  const s = await stack(buildSeed());
  const dash = await s.dashboard();
  assert.equal(s.fakes.twilio.count("probe"), 1);
  assert.equal(dash.status("conn_twilio"), "connected");
  s.fakes.twilio.always("probe", "unauthorized");

  await s.scheduler.advance(60_000); // the shared schedule's next round
  assert.equal((await dash.nextProbe("conn_twilio")).result.cause, "unauthorized");
  assert.equal(s.fakes.twilio.count("probe"), 2);
  assert.equal(dash.status("conn_twilio"), "checking", "one rejected check is not enough");
  assert.equal(dash.probesSent("conn_twilio"), 0);

  await s.scheduler.advance(2_000); // the monitor asks; the server calls the platform now, not at the next round
  await dash.nextProbe("conn_twilio");
  assert.equal(s.fakes.twilio.count("probe"), 3, "a confirming check is a new platform call, not the last result again");
  assert.equal(dash.status("conn_twilio"), "checking");

  await s.scheduler.advance(2_000);
  await dash.nextProbe("conn_twilio");
  assert.equal(s.fakes.twilio.count("probe"), 4);
  assert.equal(dash.status("conn_twilio"), "disconnected");

  await s.scheduler.advance(56_000); // the round after
  await dash.nextProbe("conn_twilio");
  assert.equal(s.fakes.twilio.count("probe"), 5, "rounds go on, one call each");
  assert.equal(dash.status("conn_twilio"), "disconnected");
  assert.equal(dash.probesSent("conn_twilio"), 2, "the dashboard asked only for the two confirming checks");
  assert.ok(!dash.statuses("conn_twilio").includes("paused"));
});

test("still: a reconnect from the dashboard resumes a long run where it stopped; the dashboard and a page loaded afterwards say it resumed, and nothing is sent twice", async () => {
  const s = await stack(buildSeed({ runs: [makeRun({ id: "run_t", platform: "twilio", items: 30, status: "running" })] }));
  const sends = acceptOnly(s.fakes.twilio, [SECRETS.twilioApiKeySecret], { revokeAfter: 25 });
  const dash = await s.dashboard();
  const started = await runUntilSettled(s.server.runner.start("run_t"), s.scheduler);
  assert.equal(started.error, undefined, String(started.error));
  await dash.ws.next((m) => m?.type === "run" && m.run?.id === "run_t" && m.run.status === "paused");

  dash.ws.send({ type: "probe", connectionId: "conn_twilio" });
  await dash.nextProbe("conn_twilio");
  for (let i = 0; i < 2; i++) {
    await s.scheduler.advance(2_000);
    await dash.nextProbe("conn_twilio");
  }
  assert.equal(dash.status("conn_twilio"), "disconnected");

  sends.allow(NEW.twilioApiKeySecret);
  const outcome = await within(dash.client.reconnect("conn_twilio", twilioBody()), 2_000, "reconnect()");
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.resumed, ["run_t"]);
  assert.equal(dash.status("conn_twilio"), "connected");
  await dash.ws.next((m) => m?.type === "run" && m.run?.id === "run_t" && m.run.status === "completed");
  await dash.settle();

  assert.deepEqual(sends.accepted, Array.from({ length: 30 }, (_, i) => `run_t_item_${i + 1}`), "every message once, in order");
  const state = dash.client.state();
  assert.equal(state.runs.run_t.status, "completed");
  assert.equal(state.runs.run_t.eventCount, s.store.listEvents("run_t").length);
  const { renderToString } = await loadRender();
  const live = liveRegion(renderToString(s.client.html`<${s.client.Dashboard} state=${state} statusOf=${dash.client.statusOf} />`));
  assert.match(live, /resumed/i, `the dashboard's live region: "${live}"`);

  const page = await (await fetch(`${s.url}/dashboard`)).text();
  assert.equal(parseState(page).events.run_t.length, 20, "the page carries the newest 20 events");
  assert.match(liveRegion(page), /resumed/i, "the resume is among them, and the page says so");
  assert.deepEqual(leaks(dash.ws.messages, [...s.secrets(), ...NEW_SECRETS]), []);
});

test("still: after Google rejects a credential mid-campaign, no numbered live message, snapshot or page of events carries a token", async () => {
  const run = makeRun({ id: "run_g", platform: "google", items: 2, status: "running" });
  const s = await stack(buildSeed({ runs: [run, makeRun({ id: "run_old", platform: "twilio", items: 1, status: "completed", nextIndex: 1 })], events: [storedDiagnosticsEvent("run_old", 1)] }));
  const dash = await s.dashboard();
  s.fakes.google.script("send", "unauthorized", "unauthorized");
  const settled = await runUntilSettled(s.server.runner.start("run_g"), s.scheduler);
  assert.equal(settled.error, undefined, String(settled.error));
  const ended = await dash.ws.next((m) => m?.type === "event" && (m.event?.type === "paused" || m.event?.type === "failed"));
  assert.equal(typeof ended.seq, "number", "live messages are numbered");
  dash.ws.send({ type: "probe", connectionId: "conn_google" });
  await dash.nextProbe("conn_google");
  dash.ws.send({ type: "snapshot" });
  await dash.ws.next("snapshot");

  const pages = await Promise.all(["run_g", "run_old"].map(async (id) => (await fetch(`${s.url}/api/runs/${id}/events`)).text()));
  assert.ok(pages[0].includes('"paused"') || pages[0].includes('"failed"'), "the rejection is listed");
  assert.deepEqual(leaks(dash.ws.messages, s.secrets()), [], `live messages: ${dash.ws.messages.map((m) => m.type).join(",")}`);
  assert.deepEqual(leaks(pages.join("\n"), s.secrets()), [], "GET /api/runs/:id/events");
});
