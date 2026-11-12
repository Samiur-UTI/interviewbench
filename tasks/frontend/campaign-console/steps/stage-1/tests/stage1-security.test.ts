// Stage 1, pentest finding: what the browser receives. The page is read the way a browser reads
// it (helpers/browser.ts); secrets are searched in everything, including tokens the fake platforms
// issued since (a rotated credential is still a secret).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { leaks, parseState, startTags, stateScriptText, visibleText, withoutState } from "./helpers/browser.ts";
import { HOSTILE, NOW, PUBLIC, buildSeed, hostileRun, makeRun, sentEvent, storedDiagnosticsEvent } from "./helpers/seed.ts";
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

const getText = async (url: string) => {
  const r = await fetch(url);
  return { status: r.status, text: await r.text() };
};
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

test("a lead whose name and headline contain markup is shown as text, and the page's state survives it intact", async () => {
  const name = `${HOSTILE.name}${String.fromCharCode(0x2028)} <!-- <script>`;
  const s = await stack(buildSeed({ runs: [hostileRun("run_h")], events: [sentEvent("run_h", 1, { name, headline: HOSTILE.headline })] }));
  const page = await getText(`${s.url}/dashboard`);
  assert.equal(page.status, 200);

  const text = stateScriptText(page.text);
  assert.doesNotMatch(text, /<\/script|<!--|<script/i, "nothing in the state can end the script element or change how it ends");
  const state = parseState(page.text);
  const event = state.events.run_h?.[0];
  assert.equal(event?.target?.name, name, "the name round-trips exactly");
  assert.equal(event?.target?.headline, HOSTILE.headline, "the headline round-trips exactly");

  const markup = withoutState(page.text);
  const tags = startTags(markup);
  assert.ok(!tags.some((t) => /^<img\b/i.test(t)), "no <img> element was created from data");
  assert.ok(!tags.some((t) => /\son[a-z]+\s*=/i.test(t)), "no event-handler attribute was created from data");
  assert.ok(tags.filter((t) => /^<script\b/i.test(t)).every((t) => /\bsrc\s*=/i.test(t)), "the only other script is the module");
  const visible = squash(visibleText(markup));
  assert.ok(visible.includes(squash(HOSTILE.headline)), "the headline is shown, as text");
  assert.ok(visible.includes(squash(HOSTILE.name)), "the name is shown, as text");
});

test("the page and the JSON API carry no secret, and each connection shows its method's public identifiers", async () => {
  const run = makeRun({ id: "run_t", platform: "twilio", items: 2, status: "completed", nextIndex: 2 });
  const s = await stack(
    buildSeed({ lastProbeOk: true, runs: [run], events: [storedDiagnosticsEvent("run_t", 1), sentEvent("run_t", 2, { name: "Target 2" })] }),
  );
  const page = await getText(`${s.url}/dashboard`);
  const dashboard = await getText(`${s.url}/api/dashboard`);
  assert.equal(dashboard.status, 200);
  const one: Record<string, any> = {};
  for (const id of ["conn_google", "conn_meta", "conn_twilio", "conn_linkfolio"]) {
    const r = await getText(`${s.url}/api/connections/${id}`);
    assert.equal(r.status, 200, id);
    one[id] = JSON.parse(r.text);
  }
  const missing = await fetch(`${s.url}/api/connections/conn_nope`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });

  assert.deepEqual(leaks(page.text, s.secrets()), [], "page");
  assert.deepEqual(leaks(dashboard.text, s.secrets()), [], "/api/dashboard");
  assert.deepEqual(leaks(one, s.secrets()), [], "/api/connections/:id");

  const expected: Record<string, Record<string, unknown>> = {
    conn_google: { method: "oauth", scope: PUBLIC.googleScope, expiresAt: NOW + 3_600_000 },
    conn_meta: { method: "oauth", scope: PUBLIC.metaScope, expiresAt: NOW + 40 * 24 * 3_600_000 },
    conn_twilio: { method: "api_key", accountSid: PUBLIC.twilioAccountSid, apiKeySid: PUBLIC.twilioApiKeySid },
    conn_linkfolio: { method: "session", userAgent: PUBLIC.linkfolioUserAgent, profileUrl: PUBLIC.linkfolioProfileUrl },
  };
  const state = JSON.parse(dashboard.text);
  for (const [id, fields] of Object.entries(expected)) {
    for (const [key, value] of Object.entries(fields)) {
      assert.deepEqual(one[id].public?.[key], value, `${id} public.${key} (/api/connections)`);
      assert.deepEqual(state.connections[id].public?.[key], value, `${id} public.${key} (/api/dashboard)`);
    }
    assert.equal(one[id].lastProbe?.ok, true, `${id} lastProbe is shown`);
  }
  assert.deepEqual(
    state.events.run_t.map((e: any) => e.id),
    [1, 2],
    "events are not dropped",
  );
  assert.deepEqual(parseState(page.text).connections.conn_twilio.public?.accountSid, PUBLIC.twilioAccountSid, "the page has them too");
});

test("after Google rejects a credential mid-campaign, no page, API or live message carries a token, not even the rotated one", async () => {
  const run = makeRun({ id: "run_g", platform: "google", items: 2, status: "running" });
  const s = await stack(buildSeed({ runs: [run] }));
  const dash = await s.dashboard();
  s.fakes.google.script("send", "unauthorized", "unauthorized"); // fails, forced refresh, fails again

  const settled = await runUntilSettled(s.server.runner.start("run_g"), s.scheduler);
  assert.equal(settled.error, undefined, String(settled.error));
  assert.equal(s.fakes.google.issued.length, 1, "the runner refreshed the token once (so the old one was rotated)");
  const ended = await dash.ws.next((m) => m?.type === "event" && (m.event?.type === "failed" || m.event?.type === "paused"));
  assert.ok(typeof ended.event.message === "string" && ended.event.message.length > 0, "the failure is reported");

  dash.ws.send({ type: "probe", connectionId: "conn_google" });
  await dash.nextProbe("conn_google");
  const page = await getText(`${s.url}/dashboard`);
  const api = await getText(`${s.url}/api/dashboard`);
  const google = await getText(`${s.url}/api/connections/conn_google`);
  await s.scheduler.settle();

  assert.deepEqual(leaks(dash.ws.messages, s.secrets()), [], `live messages: ${dash.ws.messages.map((m) => m.type).join(",")}`);
  assert.deepEqual(leaks(page.text, s.secrets()), [], "page");
  assert.deepEqual(leaks(api.text, s.secrets()), [], "/api/dashboard");
  assert.deepEqual(leaks(google.text, s.secrets()), [], "/api/connections/conn_google");
  const events = JSON.parse(api.text).events.run_g;
  assert.ok(events.some((e: any) => e.type === "failed" || e.type === "paused"), "the rejection is still listed");
});
