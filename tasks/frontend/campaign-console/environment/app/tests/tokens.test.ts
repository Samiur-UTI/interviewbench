import assert from "node:assert/strict";
import { test } from "node:test";
import { NotFoundError, PlatformError, TokenCache, config, createStore } from "../src/index.ts";
import { FakeScheduler, flush } from "./helpers/fake-scheduler.ts";
import { fakeAdapter } from "./helpers/fake-platforms.ts";
import type { Connection, OAuthCredential, PlatformRegistry, Seed } from "../src/index.ts";

const HOUR = 3_600_000;

function setup(expiresInMs: number, refresh?: (credential: OAuthCredential) => Promise<OAuthCredential>) {
  const scheduler = new FakeScheduler();
  const google: Connection = {
    id: "conn_google",
    platform: "google",
    method: "oauth",
    label: "Google Ads",
    accountName: "Acme",
    credential: { method: "oauth", accessToken: "old", refreshToken: "refresh", expiresAt: scheduler.now() + expiresInMs, scope: "adwords" },
    createdAt: 0,
  };
  const twilio: Connection = {
    id: "conn_twilio",
    platform: "twilio",
    method: "api_key",
    label: "Twilio",
    accountName: "Acme SMS",
    credential: { method: "api_key", accountSid: "AC1", apiKeySid: "SK1", apiKeySecret: "secret" },
    createdAt: 0,
  };
  const seed: Seed = { connections: [google, twilio], campaigns: [], runs: [] };
  const store = createStore(seed);
  let issued = 0;
  const adapter = fakeAdapter("google", {
    refresh:
      (refresh as ((c: unknown) => Promise<OAuthCredential>) | undefined) ??
      (async (credential) => ({ ...(credential as OAuthCredential), accessToken: `new-${++issued}`, expiresAt: scheduler.now() + HOUR })),
  });
  const platforms = { google: adapter, twilio: fakeAdapter("twilio") } as unknown as PlatformRegistry;
  const tokens = new TokenCache(store, platforms, scheduler, config.tokens);
  return { scheduler, store, adapter, tokens };
}

test("a token that is still valid is returned without a refresh", async () => {
  const { tokens, adapter } = setup(HOUR);
  const credential = (await tokens.getFresh("conn_google")) as OAuthCredential;
  assert.equal(credential.accessToken, "old");
  assert.equal(adapter.refreshes.length, 0);
});

test("a token within the refresh margin is refreshed and stored", async () => {
  const { tokens, adapter, store } = setup(config.tokens.refreshMarginMs - 1);
  const credential = (await tokens.getFresh("conn_google")) as OAuthCredential;
  assert.equal(credential.accessToken, "new-1");
  assert.equal(adapter.refreshes.length, 1);
  assert.equal((store.getConnection("conn_google")!.credential as OAuthCredential).accessToken, "new-1");
  assert.equal((tokens.peek("conn_google") as OAuthCredential).accessToken, "new-1");
});

test("concurrent callers share one refresh", async () => {
  const { tokens, adapter } = setup(-1);
  const results = await Promise.all([tokens.getFresh("conn_google"), tokens.getFresh("conn_google"), tokens.getFresh("conn_google")]);
  assert.equal(adapter.refreshes.length, 1);
  assert.deepEqual(
    results.map((c) => (c as OAuthCredential).accessToken),
    ["new-1", "new-1", "new-1"],
  );
});

test("force refreshes a token that looks valid", async () => {
  const { tokens, adapter } = setup(HOUR);
  await tokens.getFresh("conn_google");
  const credential = (await tokens.getFresh("conn_google", { force: true })) as OAuthCredential;
  assert.equal(credential.accessToken, "new-1");
  assert.equal(adapter.refreshes.length, 1);
});

test("a failed refresh is not cached: the next call tries again", async () => {
  let fail = true;
  const { tokens, scheduler } = setup(-1, async (credential) => {
    if (fail) throw new PlatformError("unreachable", "timeout");
    return { ...credential, accessToken: "recovered", expiresAt: scheduler.now() + HOUR };
  });
  await assert.rejects(tokens.getFresh("conn_google"), PlatformError);
  fail = false;
  await flush();
  assert.equal(((await tokens.getFresh("conn_google")) as OAuthCredential).accessToken, "recovered");
});

test("api_key credentials are returned as stored; unknown ids throw NotFoundError", async () => {
  const { tokens } = setup(HOUR);
  assert.deepEqual(await tokens.getFresh("conn_twilio"), { method: "api_key", accountSid: "AC1", apiKeySid: "SK1", apiKeySecret: "secret" });
  await assert.rejects(tokens.getFresh("conn_nope"), NotFoundError);
});
