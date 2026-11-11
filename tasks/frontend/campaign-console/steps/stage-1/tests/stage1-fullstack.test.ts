// Stage 1, both halves: createApp with fake platforms, a real WebSocket, and the app's own
// createDashboardClient on the SAME fake scheduler (helpers/stack.ts). Every wait is "the next
// message of this type within 2 s real time"; the fake clock only moves between those waits.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadRender } from "./helpers/app.ts";
import { NOW, SECRETS, buildSeed } from "./helpers/seed.ts";
import { createStack } from "./helpers/stack.ts";
import type { Stack, StackOptions } from "./helpers/stack.ts";

const stacks: Stack[] = [];
after(async () => {
  for (const s of stacks) await s.close();
});
async function stack(seed = buildSeed(), setup?: StackOptions["setup"]): Promise<Stack> {
  const s = await createStack({ seed, setup });
  stacks.push(s);
  return s;
}

test("Twilio answers one check slowly, then recovers: the card never shows Disconnected and ends Connected", async () => {
  const s = await stack();
  const dash = await s.dashboard();
  assert.equal(dash.status("conn_twilio"), "connected");

  s.fakes.twilio.script("probe", "unreachable");
  dash.ws.send({ type: "probe", connectionId: "conn_twilio" }); // "Check now"
  const failed = await dash.nextProbe("conn_twilio");
  assert.deepEqual([failed.result.ok, failed.result.cause], [false, "unreachable"]);
  assert.equal(dash.status("conn_twilio"), "checking");

  await s.scheduler.advance(2_000);
  const recovered = await dash.nextProbe("conn_twilio");
  assert.equal(recovered.result.ok, true);
  assert.equal(dash.status("conn_twilio"), "connected");
  assert.ok(!dash.statuses("conn_twilio").includes("disconnected"), `statuses: ${dash.statuses("conn_twilio").join(" -> ")}`);
});

test("a Twilio key that was really deleted shows Disconnected after exactly three platform checks, 2 s apart", async () => {
  // Dead from the start: the first check the server makes (when it starts, or when the dashboard
  // connects) is already rejected, and counts as the first of the three.
  const s = await stack(buildSeed(), (fakes) => fakes.twilio.always("probe", "unauthorized"));
  const dash = await s.dashboard();
  assert.equal(s.fakes.twilio.count("probe"), 1, "the first check of the connection");
  assert.equal(dash.status("conn_twilio"), "checking", "one rejected check is not enough for Reconnect");

  await s.scheduler.advance(2_000);
  await dash.nextProbe("conn_twilio");
  assert.equal(s.fakes.twilio.count("probe"), 2);
  assert.equal(dash.status("conn_twilio"), "checking");

  await s.scheduler.advance(2_000);
  await dash.nextProbe("conn_twilio");
  assert.equal(s.fakes.twilio.count("probe"), 3);
  assert.equal(dash.status("conn_twilio"), "disconnected");

  await s.scheduler.advance(10_000);
  assert.equal(s.fakes.twilio.count("probe"), 3, "no further checks once Disconnected");
  assert.equal(dash.status("conn_twilio"), "disconnected");
});

test("a Google connection whose stored token expired an hour ago stays Connected, checked with a refreshed token", async () => {
  const s = await stack(buildSeed({ googleExpiresAt: NOW - 3_600_000 }));
  const dash = await s.dashboard();
  assert.equal(dash.status("conn_google"), "connected", `snapshot lastProbe: ${JSON.stringify(dash.snapshot.state.connections.conn_google?.lastProbe)}`);

  dash.ws.send({ type: "probe", connectionId: "conn_google" });
  assert.equal((await dash.nextProbe("conn_google")).result.ok, true);
  await s.scheduler.advance(4_000);
  assert.equal(dash.status("conn_google"), "connected");
  assert.ok(!dash.statuses("conn_google").includes("disconnected"));

  const tokens = s.fakes.google.calls.filter((c) => c.method === "probe").map((c) => c.token);
  assert.ok(tokens.length >= 1);
  assert.ok(!tokens.includes(SECRETS.googleAccessToken), "the expired token was never sent");
  assert.ok(tokens.every((t) => s.fakes.google.issued.includes(t)), "every check used a refreshed token");
});

test("when Twilio is down the circuit opens and the card shows Paused, without a Reconnect button and without further checks", async () => {
  const s = await stack();
  const dash = await s.dashboard();
  s.fakes.twilio.always("probe", "unreachable");
  for (let i = 0; i < 5; i++) await s.server.probes.probe("conn_twilio");
  const calls = s.fakes.twilio.count("probe");

  dash.ws.send({ type: "probe", connectionId: "conn_twilio" });
  const pushed = await dash.nextProbe("conn_twilio");
  assert.deepEqual([pushed.result.ok, pushed.result.cause], [false, "circuit_open"]);
  assert.equal(s.fakes.twilio.count("probe"), calls, "an open circuit doesn't call the platform");
  assert.equal(dash.status("conn_twilio"), "paused");

  await s.scheduler.advance(10_000);
  assert.equal(dash.probesSent("conn_twilio"), 1, "only the check the test asked for");
  assert.equal(dash.status("conn_twilio"), "paused");

  const { renderToString } = await loadRender();
  const card = (status: string) =>
    renderToString(s.client.html`<${s.client.ConnectionCard} connection=${dash.client.state().connections.conn_twilio} status=${status} />`);
  const reconnect = /<button\b[^>]*>[^<]*reconnect/i;
  assert.doesNotMatch(card("paused"), reconnect);
  assert.match(card("disconnected"), reconnect, "a disconnected card still offers Reconnect");
});

test("a check asked for by one dashboard makes exactly one platform call, and every open dashboard gets the result", async () => {
  const s = await stack();
  const a = await s.dashboard();
  const b = await s.dashboard();
  const before = s.fakes.meta.count("probe");
  a.ws.send({ type: "probe", connectionId: "conn_meta" });
  const [ra, rb] = await Promise.all([a.nextProbe("conn_meta"), b.nextProbe("conn_meta")]);
  assert.equal(ra.result.ok, true);
  assert.deepEqual(rb.result, ra.result);
  assert.equal(s.fakes.meta.count("probe"), before + 1);
  assert.equal(b.probesSent("conn_meta"), 0);
});
