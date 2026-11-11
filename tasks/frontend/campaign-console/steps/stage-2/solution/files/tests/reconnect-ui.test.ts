// Reconnect and resume, browser side: the form per platform (rendered on the server, read as
// markup), the body it builds, the dashboard client's reconnect, the reducer and the live region.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "../vendor/preact/render-to-string.mjs";
import { ConnectionCard, Dashboard, ReconnectForm, createDashboardClient, html, reconnectBody, reduce } from "../src/client/index.ts";
import { config } from "../src/shared/config.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import type { DashboardState, PublicConnection } from "../src/shared/types.ts";

const twilio: PublicConnection = {
  id: "conn_twilio",
  platform: "twilio",
  method: "api_key",
  label: "Twilio",
  accountName: "Acme SMS",
  public: { method: "api_key", accountSid: "AC123", apiKeySid: "SK123" },
};
const google: PublicConnection = {
  id: "conn_google",
  platform: "google",
  method: "oauth",
  label: "Google Ads",
  accountName: "Acme",
  public: { method: "oauth", scope: "https://www.googleapis.com/auth/adwords", expiresAt: 1 },
};
const meta: PublicConnection = { ...google, id: "conn_meta", platform: "meta", label: "Meta" };

/** The start tag of the input named `name`. */
const input = (markup: string, name: string) => new RegExp(`<input[^>]*name="${name.replace(".", "\\.")}"[^>]*>`).exec(markup)?.[0];
const attr = (tag: string | undefined, name: string) => (tag ? new RegExp(`\\s${name}(?:="([^"]*)")?[\\s/>]`).exec(tag) : null);

test("the Twilio form shows the account read-only, prefills the key SID and asks for the secret as a password", () => {
  const markup = renderToString(html`<${ReconnectForm} connection=${twilio} />`);
  const account = input(markup, "accountSid");
  assert.equal(attr(account, "value")?.[1], "AC123");
  assert.ok(attr(account, "readonly"));
  assert.equal(attr(input(markup, "apiKeySid"), "value")?.[1], "SK123");
  assert.ok(!attr(input(markup, "apiKeySid"), "readonly"));
  assert.equal(attr(input(markup, "apiKeySecret"), "type")?.[1], "password");
  for (const name of ["accountSid", "apiKeySid", "apiKeySecret"]) {
    const id = attr(input(markup, name), "id")?.[1];
    assert.ok(id && markup.includes(`<label for="${id}"`), `${name} is labelled`);
  }
  assert.match(markup, /<form[^>]*aria-labelledby="reconnect-conn_twilio-title"/);
});

test("Google asks for an optional refresh token and the expiry in seconds; Meta has no refresh token field", () => {
  const g = renderToString(html`<${ReconnectForm} connection=${google} />`);
  assert.equal(attr(input(g, "expiresIn"), "value")?.[1], "3600");
  assert.ok(input(g, "refreshToken") && !attr(input(g, "refreshToken"), "required"));
  const m = renderToString(html`<${ReconnectForm} connection=${meta} />`);
  assert.equal(input(m, "refreshToken"), undefined);
  const values: Record<string, string> = { accessToken: "tok", refreshToken: "", expiresIn: "5184000" };
  assert.deepEqual(reconnectBody(google, (n) => values[n] ?? ""), { accessToken: "tok", expiresIn: 5_184_000 }, "an empty refresh token is left out");
});

test("a refused field is marked invalid and described by its message; submit is disabled while sending", () => {
  const markup = renderToString(html`<${ReconnectForm} connection=${twilio} error=${{ error: "invalid_credential", field: "apiKeySecret" }} pending=${true} />`);
  const secret = input(markup, "apiKeySecret");
  assert.equal(attr(secret, "aria-invalid")?.[1], "true");
  const described = attr(secret, "aria-describedby")?.[1] ?? "";
  assert.ok(described.split(" ").some((id) => new RegExp(`id="${id}"[^>]*>[^<]+`).test(markup)));
  assert.equal(attr(input(markup, "apiKeySid"), "aria-invalid"), null);
  assert.match(markup, /<button type="submit"[^>]*disabled/);
});

test("the Reconnect button is described by the card's status", () => {
  const markup = renderToString(html`<${ConnectionCard} connection=${twilio} status="disconnected" />`);
  assert.match(markup, /<button[^>]*aria-describedby="connection-conn_twilio-status"/);
  assert.match(markup, /id="connection-conn_twilio-status"[^>]*>[\s\S]*?Disconnected/);
});

test("dashboard client: a passed reconnect shows Connected from the answer; a refused one reports the field", async () => {
  const scheduler = new FakeScheduler();
  const sent: unknown[] = [];
  let answer: { status: number; body: unknown } = { status: 400, body: { error: "invalid_credential", field: "apiKeySecret" } };
  const client = createDashboardClient({
    config,
    scheduler,
    send: (m) => sent.push(m),
    fetch: async () => new Response(JSON.stringify(answer.body), { status: answer.status }),
  });
  client.handle({ type: "snapshot", state: { connections: { conn_twilio: twilio }, campaigns: {}, runs: {}, events: {} } });
  for (let i = 0; i < 3; i++) client.handle({ type: "probe", result: { connectionId: "conn_twilio", ok: false, cause: "unauthorized", checkedAt: i } });
  assert.equal(client.statusOf("conn_twilio"), "disconnected");

  const body = { accountSid: "AC123", apiKeySid: "SK9", apiKeySecret: "s" };
  assert.deepEqual(await client.reconnect("conn_twilio", body), { ok: false, error: "invalid_credential", field: "apiKeySecret" });
  assert.equal(client.statusOf("conn_twilio"), "disconnected");

  const probe = { connectionId: "conn_twilio", ok: true, checkedAt: 10 };
  answer = { status: 200, body: { connection: { ...twilio, lastProbe: probe }, probe, resumed: ["run_1"] } };
  const outcome = await client.reconnect("conn_twilio", body);
  assert.equal(outcome.ok, true);
  assert.equal(client.statusOf("conn_twilio"), "connected");
  assert.deepEqual(client.state().connections.conn_twilio.lastProbe, probe);
  assert.equal(sent.filter((m) => (m as { type: string }).type === "probe").length, 0);
});

test("the live region announces a resumed run, from the events, so a fresh snapshot says the same", () => {
  const state: DashboardState = {
    connections: { conn_twilio: twilio },
    campaigns: { camp_1: { id: "camp_1", name: "Spring SMS", platform: "twilio", connectionId: "conn_twilio", itemLabel: "SMS", createdAt: 0 } },
    runs: { run_1: { id: "run_1", campaignId: "camp_1", connectionId: "conn_twilio", status: "paused", pausedReason: "unauthorized", progress: { nextIndex: 1, sent: 1, total: 3 }, startedAt: 0, updatedAt: 0 } },
    events: { run_1: [{ id: 1, runId: "run_1", at: 1, type: "paused", message: "Paused" }] },
  };
  const region = (s: DashboardState) => /role="status"[^>]*>([^<]*)</.exec(renderToString(html`<${Dashboard} state=${s} statusOf=${() => "connected"} />`))?.[1] ?? "";
  assert.equal(region(state), "Paused: Spring SMS");
  let next = reduce(state, { type: "run", run: { ...state.runs.run_1, status: "running", pausedReason: undefined } });
  next = reduce(next, { type: "event", runId: "run_1", event: { id: 2, runId: "run_1", at: 2, type: "resumed", message: "Resumed" } });
  assert.equal(region(next), "Resumed: Spring SMS");
  assert.equal(region(reduce(next, { type: "snapshot", state: next })), "Resumed: Spring SMS");
  const replaced = reduce(next, { type: "connection", connection: { ...twilio, public: { method: "api_key", accountSid: "AC123", apiKeySid: "SK9" } } });
  assert.equal((replaced.connections.conn_twilio.public as { apiKeySid: string }).apiKeySid, "SK9");
});
