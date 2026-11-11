// Stage 2, browser half: the reducer, createDashboardClient().reconnect with an injected fetch, and
// the Dashboard's live region, from src/client/index.ts alone (no server).
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadClient, loadRender } from "./helpers/app.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import { elements, textOf } from "./helpers/markup.ts";
import { NEW, twilioBody } from "./helpers/reconnect.ts";
import { NOW, PUBLIC } from "./helpers/seed.ts";

const CONFIG = {
  connectivity: { probeIntervalMs: 60_000, confirmIntervalMs: 2_000, confirmAttempts: 3 },
  breaker: { failureThreshold: 5, openMs: 60_000 },
  retry: { attempts: 4, baseMs: 500, maxMs: 8_000 },
  tokens: { refreshMarginMs: 60_000 },
};

function twilio(apiKeySid: string = PUBLIC.twilioApiKeySid, lastProbe?: any): any {
  return {
    id: "conn_twilio",
    platform: "twilio",
    method: "api_key",
    label: "Twilio",
    accountName: "Test SMS",
    public: { method: "api_key", accountSid: PUBLIC.twilioAccountSid, apiKeySid },
    ...(lastProbe ? { lastProbe } : {}),
  };
}

function google(): any {
  return {
    id: "conn_google",
    platform: "google",
    method: "oauth",
    label: "Google Ads",
    accountName: "Test Outdoor",
    public: { method: "oauth", scope: PUBLIC.googleScope, expiresAt: NOW + 3_600_000 },
  };
}

function run(status: string, extra: Record<string, unknown> = {}): any {
  return {
    id: "run_t",
    campaignId: "camp_twilio",
    connectionId: "conn_twilio",
    status,
    progress: { nextIndex: 2, sent: 2, total: 5 },
    startedAt: NOW - 60_000,
    updatedAt: NOW,
    ...extra,
  };
}

const campaign = { id: "camp_twilio", name: "Spring SMS reactivation", platform: "twilio", connectionId: "conn_twilio", itemLabel: "SMS", createdAt: NOW - 3_600_000 };

function state(overrides: Record<string, unknown> = {}): any {
  return {
    connections: { conn_twilio: twilio(), conn_google: google() },
    campaigns: { camp_twilio: campaign },
    runs: { run_t: run("paused", { pausedReason: "unauthorized" }) },
    events: {
      run_t: [
        { id: 1, runId: "run_t", at: NOW - 3_000, type: "sent", message: "SMS sent to Target 1", target: { name: "Target 1" } },
        { id: 2, runId: "run_t", at: NOW - 2_000, type: "sent", message: "SMS sent to Target 2", target: { name: "Target 2" } },
        { id: 3, runId: "run_t", at: NOW - 1_000, type: "paused", message: "Paused: Twilio rejected the connection's credential", target: { name: "Target 3" } },
      ],
    },
    ...overrides,
  };
}

const unauthorized = (at: number) => ({ type: "probe", result: { connectionId: "conn_twilio", ok: false, cause: "unauthorized", checkedAt: at } });

/**
 * A dashboard client whose Twilio card is Disconnected, with a scripted fetch. It gets there the way
 * README's Connectivity rules describe: a rejected result, then the two confirming checks the
 * monitor asks for confirmIntervalMs after each answer, both rejected. (Results the monitor didn't
 * ask for may or may not count as strikes; the brief leaves that to the candidate.)
 */
async function disconnectedClient(answer: (url: string, init: any) => Promise<Response>) {
  const client = await loadClient();
  const scheduler = new FakeScheduler(NOW);
  const sent: any[] = [];
  const requests: { url: string; init: any }[] = [];
  const dc = client.createDashboardClient({
    config: CONFIG,
    scheduler,
    send: (m: unknown) => sent.push(m),
    baseUrl: "http://console.test",
    fetch: (url: string, init: any) => {
      requests.push({ url: String(url), init });
      return answer(String(url), init);
    },
  });
  dc.handle({ type: "snapshot", state: state() });
  dc.handle(unauthorized(scheduler.now()));
  for (let i = 0; i < 2; i++) {
    await scheduler.advance(CONFIG.connectivity.confirmIntervalMs);
    assert.ok(sent.some((m) => m?.type === "probe" && m.connectionId === "conn_twilio"), `setup: confirming check ${i + 1} was asked for`);
    sent.length = 0;
    dc.handle(unauthorized(scheduler.now()));
  }
  assert.equal(dc.statusOf("conn_twilio"), "disconnected", "setup: three rejected checks, the last two asked for by the monitor");
  sent.length = 0;
  return { dc, scheduler, sent, requests };
}

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } }));

test("the reducer replaces a connection from a connection message and a run from a run message, leaving the rest and the old state alone", async () => {
  const { reduce } = await loadClient();
  const before = state();
  const frozen = structuredClone(before);
  const replaced = twilio(NEW.twilioApiKeySid, { connectionId: "conn_twilio", ok: true, checkedAt: NOW + 5 });
  const next = reduce(before, { type: "connection", connection: replaced });
  assert.deepEqual(next.connections.conn_twilio, replaced);
  assert.deepEqual(next.connections.conn_google, before.connections.conn_google);
  assert.deepEqual(next.runs, before.runs);
  assert.deepEqual(next.events, before.events);
  assert.deepEqual(before, frozen, "the previous state is not mutated");

  const running = run("running");
  const after = reduce(next, { type: "run", run: running });
  assert.deepEqual(after.runs.run_t, running);
  assert.equal(after.runs.run_t.pausedReason, undefined, "replaced, not merged: the pause reason is gone");
  assert.deepEqual(after.connections.conn_twilio, replaced);
});

test("a reconnect the server refuses reports the field to fix, and the card stays Disconnected", async () => {
  const { dc, sent, requests } = await disconnectedClient(() => json(400, { error: "invalid_credential", field: "apiKeySecret" }));
  const outcome = await dc.reconnect("conn_twilio", twilioBody());
  assert.deepEqual([outcome.ok, outcome.error, outcome.field], [false, "invalid_credential", "apiKeySecret"], JSON.stringify(outcome));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://console.test/api/connections/conn_twilio/credentials");
  assert.equal(String(requests[0].init?.method).toUpperCase(), "POST");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), twilioBody(), "the body is sent as JSON, as given");
  assert.equal(dc.statusOf("conn_twilio"), "disconnected");
  assert.deepEqual(sent, [], "nothing is asked of the server over the socket");

  const gone = await disconnectedClient(() => json(404, { error: "not_found" }));
  const notFound = await gone.dc.reconnect("conn_twilio", twilioBody());
  assert.deepEqual([notFound.ok, notFound.error], [false, "not_found"], JSON.stringify(notFound));
  const offline = await disconnectedClient(() => Promise.reject(new TypeError("fetch failed")));
  const network = await offline.dc.reconnect("conn_twilio", twilioBody());
  assert.deepEqual([network.ok, network.error], [false, "network"], `a request without an answer resolves, never rejects: ${JSON.stringify(network)}`);
});

test("a reconnect that passes its check shows the card Connected at once, from the answer, without waiting for the server's next message", async () => {
  const probe = { connectionId: "conn_twilio", ok: true, checkedAt: NOW + 10 };
  const connection = twilio(NEW.twilioApiKeySid, probe);
  const { dc, sent, scheduler } = await disconnectedClient(() => json(200, { connection, probe, resumed: ["run_t"] }));
  const outcome = await dc.reconnect("conn_twilio", twilioBody());
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.resumed, ["run_t"]);
  assert.deepEqual(outcome.probe, probe);
  assert.equal(dc.statusOf("conn_twilio"), "connected", "the answer's check is applied as if it had been pushed");
  assert.equal(dc.state().connections.conn_twilio.public.apiKeySid, NEW.twilioApiKeySid, "and so is the answer's connection");
  await scheduler.advance(10_000);
  assert.deepEqual(sent, [], "a passed check asks for no further checks");
  assert.equal(dc.statusOf("conn_twilio"), "connected");
});

test("the dashboard has a status live region, which says when a run resumed, also after a fresh snapshot", async () => {
  const client = await loadClient();
  const { renderToString } = await loadRender();
  const region = (s: any) => {
    const markup = renderToString(client.html`<${client.Dashboard} state=${s} statusOf=${() => "connected"} />`);
    // (Cards may have live regions of their own: what matters is what the status regions say.)
    const found = elements(markup).filter((e) => e.attrs.role === "status");
    assert.ok(found.length >= 1, 'a role="status" element, rendered whatever the state');
    return found.map((e) => textOf(markup, e)).join(" | ");
  };
  const paused = state();
  assert.doesNotMatch(region(paused), /resumed/i, "nothing resumed yet");

  // What the server sends when the run resumes: the run, running again, and its resumed event.
  const resumedEvent = { id: 4, runId: "run_t", at: NOW, type: "resumed", message: "Resumed with 2 of 5 sent", target: { name: "Target 3" } };
  let s = client.reduce(paused, { type: "run", run: run("running") });
  s = client.reduce(s, { type: "event", runId: "run_t", event: resumedEvent });
  const text = region(s);
  assert.match(text, /resumed/i, `live region: "${text}"`);
  assert.ok(text.includes(campaign.name), `the region names the campaign: "${text}"`);

  // The client re-syncs with snapshots; the page rendered from one must still say it.
  const fresh = { ...paused, runs: { run_t: run("running") }, events: { run_t: [...paused.events.run_t, resumedEvent] } };
  assert.match(region(client.reduce(s, { type: "snapshot", state: fresh })), /resumed/i, "after a snapshot");
});
