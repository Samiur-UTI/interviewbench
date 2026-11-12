// README rules 2 and 3 at the browser boundary: no secret leaves the server, platform text is shown
// as text, and nothing a browser sends can throw.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { renderToString } from "../vendor/preact/render-to-string.mjs";
import { RunList, html } from "../src/client/index.ts";
import {
  CLOSE_CODES,
  OPCODES,
  PlatformError,
  createApp,
  createStore,
  encodeFrame,
  renderDashboardPage,
  toDashboardState,
  toPublicConnection,
} from "../src/index.ts";
import { WebSocketConnection, parseClientMessage } from "../src/server/ws.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import { fakeAdapter } from "./helpers/fake-platforms.ts";
import type { Credential, OAuthCredential, PlatformRegistry, Seed } from "../src/index.ts";

const seed = (): Seed => JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8")) as Seed;

/** Every secret field of every credential in the seed (docs/platforms/). */
function secretsOf(data: Seed): string[] {
  return data.connections.flatMap(({ credential: c }) => {
    switch (c.method) {
      case "oauth":
        return [c.accessToken, ...(c.refreshToken ? [c.refreshToken] : [])];
      case "api_key":
        return [c.apiKeySecret];
      case "session":
        return [c.cookies.lf_session, c.cookies.lf_csrf];
    }
  });
}

function assertNoSecret(text: string, secrets: string[], where: string): void {
  for (const secret of secrets) assert.ok(!text.includes(secret), `${where} contains ${secret.slice(0, 6)}...`);
}

test("the dashboard state and the page carry no secret, including the support details of stored events", () => {
  const data = seed();
  const state = toDashboardState(createStore(data));
  assertNoSecret(JSON.stringify(state), secretsOf(data), "dashboard state");
  assertNoSecret(renderDashboardPage(state), secretsOf(data), "page");
  assert.ok(state.events.run_2.every((e) => !("detail" in e)));
});

test("connections expose their method's public identifiers only", () => {
  const data = seed();
  const views = Object.fromEntries(data.connections.map((c) => [c.platform, toPublicConnection(c)]));
  assert.deepEqual(views.twilio.public, { method: "api_key", accountSid: "AC55007027a397e5a48045d45d15141bbe", apiKeySid: "SK460546b9c026d8f781d28782da382dc7" });
  assert.deepEqual(Object.keys(views.google.public).sort(), ["expiresAt", "method", "scope"]);
  assert.deepEqual(Object.keys(views.linkfolio.public).sort(), ["method", "profileUrl", "userAgent"]);
  assert.ok(!("credential" in views.meta));
});

test("a token an adapter quotes in a failure never reaches the run's events, even after it was rotated", async () => {
  const scheduler = new FakeScheduler();
  const data = seed();
  const google = data.connections.find((c) => c.platform === "google")!;
  google.credential = { ...(google.credential as OAuthCredential), expiresAt: scheduler.now() + 3_600_000 };
  const quoted: string[] = [];
  const adapter = fakeAdapter("google", {
    send: async (credential: Credential) => {
      const token = (credential as OAuthCredential).accessToken;
      quoted.push(token);
      throw new PlatformError("unauthorized", `google: access token ${token} was rejected`, { request: { authorization: `Bearer ${token}` } });
    },
    refresh: async (credential: Credential) => ({ ...(credential as OAuthCredential), accessToken: "rotatedTokenAbcdefghijklmnopqrstuvwxyz0123", expiresAt: scheduler.now() + 3_600_000 }),
  });
  const store = createStore(data);
  const app = createApp({ store, platforms: { google: adapter } as unknown as PlatformRegistry, scheduler, random: () => 0 });
  const run = app.runner.start("run_3");
  for (let i = 0; i < 10 && store.getRun("run_3")!.status === "running"; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    scheduler.advance(1_000);
  }
  await run;
  assert.equal(store.getRun("run_3")!.status, "paused", "a dead credential pauses the run (stage 2), it doesn't fail it");
  assert.equal(quoted.length, 2, "one attempt, one forced refresh, one more attempt");
  const state = JSON.stringify(toDashboardState(store));
  assertNoSecret(state, [...secretsOf(seed()), ...quoted], "dashboard state");
  const paused = store.listEvents("run_3").find((e) => e.type === "paused")!;
  assert.match(paused.message, /Tents|Sleeping bags/, "the pause names the target, in our words");
  assert.ok(JSON.stringify(paused.detail).includes(quoted[1]), "support still has the adapter's details on the server");
  await app.close();
});

test("the state script can't be ended or re-moded by platform text, and parses back to the same state", () => {
  const data = seed();
  data.events!.push({ id: 4, runId: "run_2", at: 1, type: "sent", message: "x", target: { name: "</SCRIPT><script>alert(1)</script><!--", headline: `a${String.fromCharCode(0x2028)}b` } });
  const state = toDashboardState(createStore(data));
  const page = renderDashboardPage(state);
  const start = page.indexOf('<script id="__STATE__" type="application/json">') + '<script id="__STATE__" type="application/json">'.length;
  const text = page.slice(start, start + page.slice(start).search(/<\/script/i));
  assert.doesNotMatch(text, /<\/script|<!--|<script/i);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(state)));
});

test("headlines are rendered as text", () => {
  const out = renderToString(
    html`<${RunList}
      runs=${[{ id: "r", campaignId: "c", connectionId: "x", status: "running", progress: { nextIndex: 1, sent: 1, total: 2 }, startedAt: 0, updatedAt: 0 }]}
      campaigns=${{}}
      events=${{ r: [{ id: 1, runId: "r", at: 0, type: "sent", message: "sent", target: { name: "Ana", headline: '<img src=x onerror="alert(1)"> <em>Growth</em>' } }] }}
    />`,
  );
  assert.ok(!/<img|<em>/.test(out), out);
  assert.ok(out.includes("&lt;em>Growth&lt;/em>") || out.includes("&lt;em&gt;Growth&lt;/em&gt;"), out);
});

test("client messages are validated: anything else is undefined, never an exception", () => {
  assert.deepEqual(parseClientMessage('{"type":"probe","connectionId":"conn_x"}'), { type: "probe", connectionId: "conn_x" });
  assert.deepEqual(parseClientMessage('{"type":"snapshot","extra":1}'), { type: "snapshot" });
  for (const text of ["", "nope", "null", "1", "[]", "{}", '{"type":"probe"}', '{"type":"probe","connectionId":1}', '{"type":"other"}']) {
    assert.equal(parseClientMessage(text), undefined, text);
  }
});

test("a frame a client must not send closes that connection with 1002 instead of throwing", () => {
  const written: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk);
      callback();
    },
  });
  const connection = new WebSocketConnection(socket);
  let received = 0;
  connection.onMessage = () => received++;
  socket.emit("data", encodeFrame(OPCODES.text, "unmasked")); // no mask
  socket.emit("data", encodeFrame(OPCODES.text, "after", { mask: Buffer.from([1, 2, 3, 4]) }));
  assert.equal(received, 0);
  const close = written.find((b) => (b[0] & 0x0f) === OPCODES.close);
  assert.ok(close, "a close frame was sent");
  assert.equal(close.readUInt16BE(2), CLOSE_CODES.protocolError);
  assert.equal(connection.isOpen, false);
  socket.destroy();
});
