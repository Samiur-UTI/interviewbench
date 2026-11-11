// Reconnect and resume, server side: the runner pauses on a dead credential and resumes from its
// checkpoint; POST /api/connections/:id/credentials validates per platform, swaps the credential,
// checks it once and resumes only the runs it should.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { PlatformError, ValidationError, createApp, createStore } from "../src/index.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import { fakeAdapter } from "./helpers/fake-platforms.ts";
import type { App, ApiKeyCredential, Credential, OAuthCredential, PlatformRegistry, Seed } from "../src/index.ts";

const seed = (): Seed => JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8")) as Seed;
const apps: App[] = [];
after(async () => {
  for (const app of apps) await app.close();
});

const OLD_SECRET = () => (seed().connections.find((c) => c.id === "conn_twilio")!.credential as ApiKeyCredential).apiKeySecret;
const ACCOUNT = () => (seed().connections.find((c) => c.id === "conn_twilio")!.credential as ApiKeyCredential).accountSid;
const NEW_KEY = { apiKeySid: "SK0123456789abcdef0123456789abcdef", apiKeySecret: "newSecretQwErTyUiOpAsDfGhJkLzXcVbNm0123456789" };

/** Twilio accepts exactly the secrets in `valid`; everything else is a 401 that quotes the key, as the real adapter does. */
function twilio(valid: Set<string>) {
  const check = (credential: Credential) => {
    const secret = (credential as ApiKeyCredential).apiKeySecret;
    if (!valid.has(secret)) throw new PlatformError("unauthorized", `twilio: key ${secret} rejected`, { request: { authorization: secret } });
  };
  return fakeAdapter("twilio", {
    probe: async (credential) => check(credential),
    send: async (credential, item) => {
      check(credential);
      return { externalId: `SM-${item.id}` };
    },
  });
}

async function setup(data = seed(), adapters: Partial<PlatformRegistry> = {}) {
  const scheduler = new FakeScheduler();
  const store = createStore(data);
  const app = createApp({ store, platforms: adapters as PlatformRegistry, scheduler, random: () => 0 });
  apps.push(app);
  const { url } = await app.listen(0);
  const post = async (id: string, body: unknown) => {
    const response = await fetch(`${url}/api/connections/${id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  /** Lets background sends (resolved promises, no timers) finish. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  // The server checks every connection once when it starts listening (the shared schedule's first
  // round): let that finish and forget it, so each test counts only the checks it causes.
  await settle();
  for (const adapter of Object.values(adapters) as { probes?: unknown[] }[]) adapter.probes?.splice(0);
  return { app, store, scheduler, post, settle };
}

test("a dead Twilio key pauses the run at the message it couldn't send; resume continues from there and sends nothing twice", async () => {
  const valid = new Set([OLD_SECRET()]);
  const adapter = twilio(valid);
  const data = seed();
  data.runs.push({ ...structuredClone(data.runs.find((r) => r.id === "run_4")!), id: "run_9", status: "running", pausedReason: undefined });
  const { app, store, settle } = await setup(data, { twilio: adapter });
  adapter.send = async (credential, item) => {
    adapter.sends.push({ credential, item });
    if (adapter.sends.length === 2) valid.clear(); // the customer deletes the key after one more message
    if (!valid.has((credential as ApiKeyCredential).apiKeySecret) && adapter.sends.length > 2) throw new PlatformError("unauthorized", "twilio: 401");
    return { externalId: `SM-${item.id}` };
  };

  await app.runner.start("run_9");
  const paused = store.getRun("run_9")!;
  assert.deepEqual([paused.status, paused.pausedReason, paused.progress.nextIndex], ["paused", "unauthorized", 3]);
  assert.ok(store.listEvents("run_9").some((e) => e.type === "paused"));

  valid.add(NEW_KEY.apiKeySecret);
  store.updateConnection("conn_twilio", { credential: { method: "api_key", accountSid: ACCOUNT(), ...NEW_KEY } });
  app.tokens.invalidate("conn_twilio");
  await app.runner.resume("run_9");
  await settle();
  const run = store.getRun("run_9")!;
  assert.equal(run.status, "completed");
  const accepted = adapter.sends.filter((s) => (s.credential as ApiKeyCredential).apiKeySecret === NEW_KEY.apiKeySecret).map((s) => s.item.id);
  assert.deepEqual(accepted, [run.items[3].id], "only the message that was rejected, once");
  await assert.rejects(app.runner.resume("run_9"), ValidationError, "a run that isn't paused can't be resumed");
});

test("a reconnect validates the body for the connection's method, in order, before touching anything", async () => {
  const adapter = twilio(new Set([NEW_KEY.apiKeySecret]));
  const { post, store } = await setup(seed(), { twilio: adapter });
  const before = store.getConnection("conn_twilio")!.credential;
  const cases: [unknown, number, string][] = [
    ["{oops", 400, "invalid_json"],
    ["[1]", 400, "invalid_json"],
    [{}, 400, "accountSid"],
    [{ accountSid: "AC00000000000000000000000000000000", ...NEW_KEY }, 400, "accountSid"],
    [{ accountSid: ACCOUNT() }, 400, "apiKeySid"],
    [{ accountSid: ACCOUNT(), apiKeySid: NEW_KEY.apiKeySid }, 400, "apiKeySecret"],
  ];
  for (const [body, status, code] of cases) {
    const r = await post("conn_twilio", body);
    assert.equal(r.status, status, `${JSON.stringify(body)}: ${r.text}`);
    assert.equal(r.body.field ?? r.body.error, code, `${JSON.stringify(body)}: ${r.text}`);
  }
  assert.equal((await post("conn_nope", {})).status, 404);
  assert.deepEqual(store.getConnection("conn_twilio")!.credential, before);
  assert.equal(adapter.probes.length, 0);

  const google = await post("conn_google", { accessToken: "x".repeat(40), refreshToken: 7, expiresIn: "3600" });
  assert.equal(google.body.field, "refreshToken");
  const linkedin = await post("conn_linkedin", { cookies: { li_at: "a" }, userAgent: "UA" });
  assert.equal(linkedin.body.field, "cookies.JSESSIONID");
});

test("Google: expiresIn is seconds, a reconnect without a refresh token keeps ours, Meta never stores one", async () => {
  const google = fakeAdapter("google", { refresh: async (c) => ({ ...(c as OAuthCredential), accessToken: "refreshedAbcdefghijklmnopqrstuvwxyz012345", expiresAt: Date.now() }) });
  const meta = fakeAdapter("meta");
  const { post, store, scheduler } = await setup(seed(), { google, meta });
  const storedRefresh = (store.getConnection("conn_google")!.credential as OAuthCredential).refreshToken;
  const r = await post("conn_google", { accessToken: "newGoogleTokenAbcdefghijklmnopqrstuvwxyz0", expiresIn: 3599 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.connection.public.expiresAt, scheduler.now() + 3_599_000);
  assert.equal((google.probes[0] as OAuthCredential).accessToken, "newGoogleTokenAbcdefghijklmnopqrstuvwxyz0", "checked with the new token, not refreshed");
  assert.equal((store.getConnection("conn_google")!.credential as OAuthCredential).refreshToken, storedRefresh);
  assert.ok(!r.text.includes("newGoogleToken") && !r.text.includes(storedRefresh!), "no secret in the answer");

  await post("conn_meta", { accessToken: "newMetaTokenAbcdefghijklmnopqrstuvwxyz0123", refreshToken: "metaHasNoneAbcdefghijklmnopqrstuvwxyz01", expiresIn: 5_184_000 });
  assert.equal((store.getConnection("conn_meta")!.credential as OAuthCredential).refreshToken, undefined);
});

test("a reconnect keeps the LinkedIn profile and the Twilio account, and drops fields the credential doesn't have", async () => {
  const { post, store } = await setup(seed(), { twilio: twilio(new Set([NEW_KEY.apiKeySecret])), linkedin: fakeAdapter("linkedin") });
  const profileUrl = (seed().connections.find((c) => c.id === "conn_linkedin")!.credential as { profileUrl: string }).profileUrl;
  const li = await post("conn_linkedin", { cookies: { li_at: "liAt".repeat(10), JSESSIONID: "ajax".repeat(10) }, userAgent: "UA/1", profileUrl: "https://example.com/x" });
  assert.equal(li.status, 200, li.text);
  assert.deepEqual(li.body.connection.public, { method: "session", userAgent: "UA/1", profileUrl });
  await post("conn_twilio", { accountSid: ACCOUNT(), ...NEW_KEY, admin: true });
  assert.deepEqual(store.getConnection("conn_twilio")!.credential, { method: "api_key", accountSid: ACCOUNT(), ...NEW_KEY });
});

test("a reconnect drops the cached token and the open circuit, checks once, and resumes only this connection's runs paused for the credential", async () => {
  const valid = new Set([OLD_SECRET()]);
  const adapter = twilio(valid);
  const data = seed();
  data.runs.push(
    { ...structuredClone(data.runs.find((r) => r.id === "run_4")!), id: "run_8", pausedReason: "unauthorized" },
    { ...structuredClone(data.runs.find((r) => r.id === "run_3")!), id: "run_7", status: "paused", pausedReason: "unauthorized" },
  );
  const { app, post, store, settle } = await setup(data, { twilio: adapter, google: fakeAdapter("google") });
  await app.probes.probe("conn_twilio"); // caches the old key
  for (let i = 0; i < 5; i++) app.breakers.record("conn_twilio", "unreachable"); // and an outage opened the circuit
  assert.equal(app.breakers.isOpen("conn_twilio"), true);
  adapter.probes.length = 0;

  valid.clear(); // the old key was deleted; the customer created a new one
  valid.add(NEW_KEY.apiKeySecret);
  const r = await post("conn_twilio", { accountSid: ACCOUNT(), ...NEW_KEY });
  assert.equal(r.status, 200, r.text);
  assert.equal(adapter.probes.length, 1, "one platform call, with the circuit reset");
  assert.equal(r.body.probe.ok, true, "with the new key, not the cached one");
  assert.deepEqual(r.body.resumed, ["run_8"]);
  await settle();
  assert.equal(store.getRun("run_8")!.status, "completed", "and it finished with the new key");
  assert.equal(store.getRun("run_4")!.status, "paused", "the operator's pause stays");
  assert.equal(store.getRun("run_7")!.status, "paused", "another connection's run stays");
  assert.ok(!r.text.includes(NEW_KEY.apiKeySecret));
});

test("nothing resumes when the new credential fails its check", async () => {
  const data = seed();
  data.runs.push({ ...structuredClone(data.runs.find((r) => r.id === "run_4")!), id: "run_8", pausedReason: "unauthorized" });
  const { post, store } = await setup(data, { twilio: twilio(new Set()) });
  const r = await post("conn_twilio", { accountSid: ACCOUNT(), ...NEW_KEY });
  assert.deepEqual([r.status, r.body.probe.ok, r.body.probe.cause, r.body.resumed], [200, false, "unauthorized", []]);
  assert.equal(store.getRun("run_8")!.status, "paused");
});
