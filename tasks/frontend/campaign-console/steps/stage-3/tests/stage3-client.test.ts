// Stage 3, browser half: createDashboardClient from src/client/index.ts alone (no server), fed
// numbered messages by hand, with a spy for what it sends and a scripted fetch; and the Dashboard's
// "Load earlier events" button, rendered with vendor/preact/render-to-string.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadClient, loadRender } from "./helpers/app.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import { elements, textOf } from "./helpers/markup.ts";
import { NOW, PUBLIC } from "./helpers/seed.ts";

const CONFIG = {
  connectivity: { probeIntervalMs: 60_000, confirmIntervalMs: 2_000, confirmAttempts: 3 },
  breaker: { failureThreshold: 5, openMs: 60_000 },
  retry: { attempts: 4, baseMs: 500, maxMs: 8_000 },
  tokens: { refreshMarginMs: 60_000 },
  dashboard: { recentEvents: 20 },
};

const event = (id: number, runId = "run_t") => ({ id, runId, at: NOW + id, type: "sent", message: `SMS sent to Target ${id}`, target: { name: `Target ${id}` } });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function run(extra: Record<string, unknown> = {}): any {
  return {
    id: "run_t",
    campaignId: "camp_twilio",
    connectionId: "conn_twilio",
    status: "running",
    progress: { nextIndex: 130, sent: 130, total: 200 },
    startedAt: NOW - 60_000,
    updatedAt: NOW,
    eventCount: 130,
    ...extra,
  };
}

function state(events = range(111, 130).map((id) => event(id)), runExtra: Record<string, unknown> = {}): any {
  return {
    connections: {
      conn_twilio: {
        id: "conn_twilio",
        platform: "twilio",
        method: "api_key",
        label: "Twilio",
        accountName: "Test SMS",
        public: { method: "api_key", accountSid: PUBLIC.twilioAccountSid, apiKeySid: PUBLIC.twilioApiKeySid },
        lastProbe: { connectionId: "conn_twilio", ok: true, checkedAt: NOW - 1_000 },
      },
    },
    campaigns: { camp_twilio: { id: "camp_twilio", name: "Spring SMS", platform: "twilio", connectionId: "conn_twilio", itemLabel: "SMS", createdAt: NOW - 3_600_000 } },
    runs: { run_t: run(runExtra) },
    events: { run_t: events },
  };
}

/** The server's side of GET /api/runs/:id/events over `all` (ids 1..n), as the brief defines it. */
function eventsServer(all: any[], requests: string[], { failFirst = false } = {}) {
  let failed = !failFirst;
  return async (url: string): Promise<Response> => {
    requests.push(String(url));
    if (!failed) {
      failed = true;
      throw new TypeError("network down");
    }
    const parsed = new URL(String(url));
    const before = parsed.searchParams.has("before") ? Number(parsed.searchParams.get("before")) : Infinity;
    const limit = parsed.searchParams.has("limit") ? Number(parsed.searchParams.get("limit")) : 50;
    const below = all.filter((e) => e.id < before);
    const events = below.slice(Math.max(0, below.length - limit));
    const nextBefore = events.length > 0 && events[0].id > 1 ? events[0].id : null;
    await new Promise((resolve) => setImmediate(resolve));
    return new Response(JSON.stringify({ events, nextBefore }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  };
}

async function setup(fetch?: (url: string) => Promise<Response>) {
  const client = await loadClient();
  const sent: any[] = [];
  const dc = client.createDashboardClient({ config: CONFIG, scheduler: new FakeScheduler(NOW), send: (m: unknown) => sent.push(m), baseUrl: "http://console.test", fetch });
  const snapshots = () => sent.filter((m) => m?.type === "snapshot").length;
  return { client, dc, sent, snapshots };
}

test("a steady stream of numbered messages is applied in order and never makes the dashboard ask for a snapshot", async () => {
  const { dc, snapshots } = await setup();
  dc.handle({ type: "snapshot", seq: 5, state: state() });
  let seq = 5;
  for (let i = 1; i <= 25; i++) {
    dc.handle({ type: "event", seq: ++seq, runId: "run_t", event: event(130 + i) });
    dc.handle({ type: "run", seq: ++seq, run: run({ progress: { nextIndex: 130 + i, sent: 130 + i, total: 200 }, eventCount: 130 + i }) });
  }
  assert.equal(seq, 55, "50 messages");
  dc.handle({ type: "probe", seq: ++seq, result: { connectionId: "conn_twilio", ok: true, checkedAt: NOW + 60_000 } });
  assert.equal(snapshots(), 0, "no snapshot request");
  const s = dc.state();
  assert.deepEqual(s.events.run_t.map((e: any) => e.id), range(111, 155));
  assert.equal(s.runs.run_t.progress.sent, 155);
  assert.equal(s.runs.run_t.eventCount, 155);
  assert.equal(s.connections.conn_twilio.lastProbe.checkedAt, NOW + 60_000);
});

test("an event message adds one to its run's eventCount; the same event twice counts once", async () => {
  const { dc } = await setup();
  dc.handle({ type: "snapshot", seq: 0, state: state() });
  dc.handle({ type: "event", seq: 1, runId: "run_t", event: event(131) });
  dc.handle({ type: "event", seq: 2, runId: "run_t", event: event(132) });
  assert.equal(dc.state().runs.run_t.eventCount, 132);
  assert.deepEqual(dc.state().events.run_t.slice(-2).map((e: any) => e.id), [131, 132]);
});

test("a gap in seq makes the dashboard ask for one snapshot, and only one until it arrives; after it, a new gap asks again", async () => {
  const { dc, sent, snapshots } = await setup();
  dc.handle({ type: "snapshot", seq: 5, state: state() });
  dc.handle({ type: "event", seq: 6, runId: "run_t", event: event(131) });
  dc.handle({ type: "event", seq: 7, runId: "run_t", event: event(132) });
  assert.equal(snapshots(), 0);
  dc.handle({ type: "event", seq: 9, runId: "run_t", event: event(134) }); // 8 never arrived
  assert.equal(snapshots(), 1, "a gap: one snapshot request");
  assert.deepEqual(sent.filter((m) => m?.type === "snapshot"), [{ type: "snapshot" }]);
  dc.handle({ type: "event", seq: 10, runId: "run_t", event: event(135) });
  dc.handle({ type: "event", seq: 12, runId: "run_t", event: event(137) });
  assert.equal(snapshots(), 1, "not another while the snapshot is on its way");

  dc.handle({ type: "snapshot", seq: 12, state: state(range(118, 137).map((id) => event(id)), { eventCount: 137 }) });
  assert.deepEqual(
    dc.state().events.run_t.map((e: any) => e.id),
    range(111, 137),
    "the snapshot fills the hole; the older events the dashboard held are kept",
  );
  assert.equal(dc.state().runs.run_t.eventCount, 137);
  dc.handle({ type: "event", seq: 13, runId: "run_t", event: event(138) });
  assert.equal(snapshots(), 1);
  dc.handle({ type: "event", seq: 15, runId: "run_t", event: event(140) });
  assert.equal(snapshots(), 2, "a later gap asks again");
});

test("loadEarlierEvents fetches the events just before the oldest one held and adds them in front, once, oldest first", async () => {
  const all = range(1, 130).map((id) => event(id));
  const requests: string[] = [];
  const { dc } = await setup(eventsServer(all, requests));
  dc.handle({ type: "snapshot", seq: 3, state: state() });

  await Promise.all([dc.loadEarlierEvents("run_t"), dc.loadEarlierEvents("run_t")]); // a double click
  const first = new URL(requests[0]);
  assert.equal(first.origin + first.pathname, "http://console.test/api/runs/run_t/events");
  assert.equal(first.searchParams.get("before"), "111", "before = the oldest event held");
  let held = dc.state().events.run_t.map((e: any) => e.id);
  assert.ok(held.length > 20, "earlier events were added");
  assert.deepEqual(held, range(held[0], 130), "once each, oldest first, no hole");

  for (let i = 0; i < 130 && held[0] !== 1; i++) {
    await dc.loadEarlierEvents("run_t");
    const next = dc.state().events.run_t.map((e: any) => e.id);
    assert.ok(next.length > held.length, "every load adds earlier events");
    held = next;
  }
  assert.deepEqual(held, range(1, 130));
  const count = requests.length;
  await dc.loadEarlierEvents("run_t");
  assert.equal(requests.length, count, "nothing is fetched once every event of the run is held");
  assert.deepEqual(dc.state().events.run_t.map((e: any) => e.id), range(1, 130));
});

test("loadEarlierEvents never rejects: a failed request leaves the events as they were, and the next one works", async () => {
  const all = range(1, 130).map((id) => event(id));
  const requests: string[] = [];
  const { dc } = await setup(eventsServer(all, requests, { failFirst: true }));
  dc.handle({ type: "snapshot", seq: 3, state: state() });
  await dc.loadEarlierEvents("run_t");
  assert.deepEqual(dc.state().events.run_t.map((e: any) => e.id), range(111, 130));
  await dc.loadEarlierEvents("run_t");
  assert.ok(dc.state().events.run_t.length > 20);
});

test('the dashboard offers "Load earlier events" on a run while it shows fewer events than the run has, and not otherwise', async () => {
  const client = await loadClient();
  const { renderToString } = await loadRender();
  const buttons = (s: any) => {
    const markup = renderToString(client.html`<${client.Dashboard} state=${s} statusOf=${() => "connected"} />`);
    return elements(markup, "button").filter((b) => /load earlier events/i.test(textOf(markup, b)));
  };
  const some = buttons(state());
  assert.equal(some.length, 1, "20 of 130 shown");
  assert.equal(some[0].attrs.type, "button", "a real button, not a link or a submit");
  assert.equal(buttons(state(range(1, 130).map((id) => event(id)))).length, 0, "all 130 shown");
  assert.equal(buttons(state([], { eventCount: 0 })).length, 0, "a run without events");
});
