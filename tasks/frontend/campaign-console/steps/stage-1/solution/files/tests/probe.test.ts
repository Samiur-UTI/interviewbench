// Health checks send what a campaign would send (README "Connectivity", rule 5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { NotFoundError, createApp, createStore } from "../src/index.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import { fakeAdapter } from "./helpers/fake-platforms.ts";
import type { Connection, Credential, OAuthCredential, PlatformRegistry } from "../src/index.ts";

const HOUR = 3_600_000;

function setup(expiresAt: (now: number) => number) {
  const scheduler = new FakeScheduler();
  const google: Connection = {
    id: "conn_google",
    platform: "google",
    method: "oauth",
    label: "Google Ads",
    accountName: "Acme",
    credential: { method: "oauth", accessToken: "expired-token", refreshToken: "refresh-token", expiresAt: expiresAt(scheduler.now()), scope: "adwords" },
    createdAt: 0,
  };
  let issued = 0;
  const adapter = fakeAdapter("google", {
    // Like Google: an expired access token is rejected.
    probe: async (credential: Credential) => {
      if ((credential as OAuthCredential).expiresAt <= scheduler.now()) throw new Error("expired token sent");
    },
    refresh: async (credential: Credential) => ({ ...(credential as OAuthCredential), accessToken: `fresh-${++issued}`, expiresAt: scheduler.now() + HOUR }),
  });
  const store = createStore({ connections: [google], campaigns: [], runs: [] });
  const app = createApp({ store, platforms: { google: adapter } as unknown as PlatformRegistry, scheduler });
  return { app, adapter, store };
}

test("an expired stored token is refreshed before the check, not reported as a dead credential", async () => {
  const { app, adapter } = setup((now) => now - HOUR);
  const result = await app.probes.probe("conn_google");
  assert.equal(result.ok, true);
  assert.deepEqual(
    adapter.probes.map((c) => (c as OAuthCredential).accessToken),
    ["fresh-1"],
  );
  await app.probes.probe("conn_google");
  assert.equal(adapter.refreshes.length, 1, "a valid token is reused");
  await app.close();
});

test("a check of an unknown connection rejects NotFoundError", async () => {
  const { app, adapter } = setup((now) => now + HOUR);
  await assert.rejects(app.probes.probe("conn_nope"), NotFoundError);
  assert.equal(adapter.probes.length, 0);
  await app.close();
});
