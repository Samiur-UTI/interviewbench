// Stage 1, server half: health checks through createApp(...).probes with fake platforms and a
// fake clock. No socket, no browser code.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadApp } from "./helpers/app.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import { createFakePlatforms } from "./helpers/fake-platforms.ts";
import { within } from "./helpers/reconnect.ts";
import { NOW, PUBLIC, SECRETS, buildSeed, makeRun } from "./helpers/seed.ts";

const HOUR = 3_600_000;
const apps: { close(): Promise<void> }[] = [];
after(async () => {
  for (const a of apps) await a.close();
});

async function backend(seed: any) {
  const app = await loadApp();
  const scheduler = new FakeScheduler(NOW);
  const fakes = createFakePlatforms(app, { clock: scheduler });
  const store = app.createStore(seed);
  const server = app.createApp({ store, platforms: fakes.registry, scheduler, random: () => 0 });
  apps.push(server);
  return { app, scheduler, fakes, store, server };
}

test("a Google connection whose stored access token expired an hour ago checks healthy, using a refreshed token", async () => {
  const { server, fakes, store } = await backend(buildSeed({ googleExpiresAt: NOW - HOUR }));
  const result = await server.probes.probe("conn_google");
  assert.equal(result.ok, true, `probe answered ${JSON.stringify(result)}`);
  assert.equal(fakes.google.count("refresh"), 1);
  assert.deepEqual(
    fakes.google.calls.filter((c) => c.method === "probe").map((c) => c.token),
    [fakes.google.issued[0]],
    "the platform was asked with the refreshed token, never the expired one",
  );
  assert.equal(store.getConnection("conn_google").lastProbe.ok, true);
  await server.probes.probe("conn_google");
  assert.equal(fakes.google.count("refresh"), 1, "a token that is still valid is not refreshed again");
});

test("a check and a campaign send that both find the Google token expired share a single refresh", async () => {
  const run = makeRun({ id: "run_g", platform: "google", items: 1, status: "running" });
  const { server, fakes, scheduler, store } = await backend(buildSeed({ googleExpiresAt: NOW - HOUR, runs: [run] }));
  const gate = fakes.google.defer("refresh");
  const probe = server.probes.probe("conn_google");
  const running = server.runner.start("run_g");
  await within(gate.started, 2_000, "a refresh of the expired Google token");
  await scheduler.settle(10); // both callers have reached the token cache by now
  gate.release();
  const result = await probe;
  await running;
  assert.equal(result.ok, true);
  assert.equal(fakes.google.count("refresh"), 1, "Google rate-limits refresh bursts: one refresh for both");
  assert.equal(store.getRun("run_g").status, "completed");
  assert.equal(fakes.google.calls.find((c) => c.method === "send")?.token, fakes.google.issued[0]);
});

test("Twilio and LinkedIn checks send the stored credential unchanged", async () => {
  const { server, fakes } = await backend(buildSeed());
  assert.equal((await server.probes.probe("conn_twilio")).ok, true);
  assert.equal((await server.probes.probe("conn_linkedin")).ok, true);
  assert.deepEqual(fakes.twilio.credentials("probe"), [
    { method: "api_key", accountSid: PUBLIC.twilioAccountSid, apiKeySid: PUBLIC.twilioApiKeySid, apiKeySecret: SECRETS.twilioApiKeySecret },
  ]);
  assert.deepEqual(fakes.linkedin.credentials("probe"), [
    {
      method: "session",
      cookies: { li_at: SECRETS.linkedinLiAt, JSESSIONID: SECRETS.linkedinJsessionId },
      userAgent: PUBLIC.linkedinUserAgent,
      profileUrl: PUBLIC.linkedinProfileUrl,
    },
  ]);
});

test("checking a connection that doesn't exist is refused as not found, without calling any platform", async () => {
  const { app, server, fakes } = await backend(buildSeed());
  await assert.rejects(server.probes.probe("conn_nope"), app.NotFoundError);
  assert.equal(fakes.count(), 0);
});

test("five unreachable checks open the circuit: the sixth answers circuit_open without calling the platform, and a trial goes through after openMs", async () => {
  const { server, fakes, scheduler } = await backend(buildSeed());
  fakes.twilio.always("probe", "unreachable");
  for (let i = 0; i < 5; i++) {
    const r = await server.probes.probe("conn_twilio");
    assert.deepEqual([r.ok, r.cause], [false, "unreachable"], `check ${i + 1}`);
  }
  const sixth = await server.probes.probe("conn_twilio");
  assert.deepEqual([sixth.ok, sixth.cause], [false, "circuit_open"]);
  assert.equal(fakes.twilio.count("probe"), 5);
  await scheduler.advance(60_000);
  fakes.twilio.always("probe", "ok");
  assert.equal((await server.probes.probe("conn_twilio")).ok, true);
  assert.equal(fakes.twilio.count("probe"), 6);
});
