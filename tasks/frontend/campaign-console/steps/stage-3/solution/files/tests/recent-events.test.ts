// Stage 3: recent events only. The store's ranges, GET /api/runs/:id/events, what the state carries,
// and the dashboard client's gap handling and "Load earlier events".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { renderToString } from "../vendor/preact/render-to-string.mjs";
import { Dashboard, createDashboardClient, html } from "../src/client/index.ts";
import { config, createApp, createStore, toDashboardState } from "../src/index.ts";
import { FakeScheduler } from "./helpers/fake-scheduler.ts";
import type { App, DashboardState, PublicEvent, RunEvent, Seed, ServerMessage } from "../src/index.ts";

const seed = (): Seed => JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8")) as Seed;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const event = (runId: string, id: number): RunEvent => ({ id, runId, at: id, type: "sent", message: `sent ${id}`, target: { name: `Lead ${id}` } });

/** The seed with its first run given `count` events. */
function longSeed(count: number): { data: Seed; runId: string } {
  const data = seed();
  const runId = data.runs[0].id;
  data.events = [...(data.events ?? []).filter((e) => e.runId !== runId), ...range(1, count).map((id) => event(runId, id))];
  return { data, runId };
}

const apps: App[] = [];
after(async () => {
  for (const app of apps) await app.close();
});

test("the store hands out ranges: newest `limit` below `before`, ascending, and counts", () => {
  const { data, runId } = longSeed(300);
  const store = createStore(data);
  assert.equal(store.countEvents(runId), 300);
  assert.deepEqual(store.listEvents(runId, { limit: 3 }).map((e) => e.id), [298, 299, 300]);
  assert.deepEqual(store.listEvents(runId, { before: 5, limit: 10 }).map((e) => e.id), [1, 2, 3, 4]);
  assert.deepEqual(store.listEvents(runId, { before: 1 }), []);
  assert.equal(store.listEvents(runId).length, 300, "no range: everything, as before");
});

test("the state carries each run's newest recentEvents and its total; the HTTP API pages through the rest", async () => {
  const { data, runId } = longSeed(1_000);
  const store = createStore(data);
  const state = toDashboardState(store, { recentEvents: 20 });
  assert.deepEqual(state.events[runId].map((e) => e.id), range(981, 1_000));
  assert.equal(state.runs[runId].eventCount, 1_000);

  const app = createApp({ store, platforms: {}, scheduler: new FakeScheduler(), config: { ...config, dashboard: { recentEvents: 5 } } });
  apps.push(app);
  const { url } = await app.listen(0);
  const get = async (path: string) => {
    const r = await fetch(`${url}${path}`);
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await get("/api/dashboard")).body.events[runId].length, 5, "the app's own config decides");

  const seen: number[] = [];
  let before: number | null = null;
  do {
    const { body } = await get(`/api/runs/${runId}/events?limit=200${before ? `&before=${before}` : ""}`);
    assert.ok(body.events.every((e: PublicEvent, i: number, all: PublicEvent[]) => i === 0 || e.id === all[i - 1].id + 1));
    seen.unshift(...body.events.map((e: PublicEvent) => e.id));
    before = body.nextBefore;
  } while (before !== null);
  assert.deepEqual(seen, range(1, 1_000));
  assert.deepEqual((await get(`/api/runs/${runId}/events`)).body.events.length, 50, "default limit");
  for (const [query, field] of [["before=0", "before"], ["before=1.5", "before"], ["limit=201", "limit"], ["limit=x", "limit"]]) {
    assert.deepEqual(await get(`/api/runs/${runId}/events?${query}`), { status: 400, body: { error: "invalid_query", field } }, query);
  }
  assert.equal((await get("/api/runs/run_nope/events")).status, 404);
});

function clientState(runId: string, ids: number[], eventCount: number): DashboardState {
  const data = seed();
  const run = data.runs.find((r) => r.id === runId)!;
  const { items: _items, ...rest } = run;
  return {
    connections: {},
    campaigns: Object.fromEntries(data.campaigns.map((c) => [c.id, c])),
    runs: { [runId]: { ...rest, eventCount } },
    events: { [runId]: ids.map((id) => event(runId, id)) },
  };
}

test("the dashboard asks for a snapshot only after a gap in seq, once per gap, and a snapshot keeps the older events it joins up with", () => {
  const sent: unknown[] = [];
  const dc = createDashboardClient({ config, scheduler: new FakeScheduler(), send: (m) => sent.push(m) });
  const runId = "run_1";
  dc.handle({ type: "snapshot", seq: 10, state: clientState(runId, range(81, 100), 100) });
  const push = (seq: number, id: number) => dc.handle({ type: "event", seq, runId, event: event(runId, id) } as ServerMessage);
  push(11, 101);
  push(12, 102);
  assert.equal(sent.length, 0);
  assert.equal(dc.state().runs[runId].eventCount, 102);
  push(14, 104);
  push(15, 105);
  assert.deepEqual(sent, [{ type: "snapshot" }], "one request for the gap");
  push(15, 105); // a repeat changes nothing
  dc.handle({ type: "snapshot", seq: 15, state: clientState(runId, range(86, 105), 105) });
  assert.deepEqual(dc.state().events[runId].map((e) => e.id), range(81, 105));
  push(17, 107);
  assert.equal(sent.length, 2, "a new gap, a new request");
});

test('"Load earlier events": shown while events are missing; loads the page before the oldest, once per double click', async () => {
  const runId = "run_1";
  const requests: string[] = [];
  const all = range(1, 60).map((id) => event(runId, id));
  const dc = createDashboardClient({
    config,
    scheduler: new FakeScheduler(),
    send: () => {},
    baseUrl: "http://test",
    fetch: (async (input: string) => {
      requests.push(input);
      const before = Number(new URL(input).searchParams.get("before") ?? Infinity);
      const below = all.filter((e) => e.id < before);
      const events = below.slice(-50);
      return new Response(JSON.stringify({ events, nextBefore: events[0]?.id > 1 ? events[0].id : null }), { status: 200 });
    }) as typeof fetch,
  });
  dc.handle({ type: "snapshot", seq: 0, state: clientState(runId, range(41, 60), 60) });
  const button = () => /Load earlier events/.test(renderToString(html`<${Dashboard} state=${dc.state()} statusOf=${() => "connected"} />`));
  assert.ok(button());
  await Promise.all([dc.loadEarlierEvents(runId), dc.loadEarlierEvents(runId)]);
  assert.equal(requests.length, 1, "a double click is one request");
  assert.match(requests[0], /\/api\/runs\/run_1\/events\?before=41$/);
  assert.deepEqual(dc.state().events[runId].map((e) => e.id), range(1, 60));
  assert.ok(!button(), "everything shown: no button");
  await dc.loadEarlierEvents(runId);
  assert.equal(requests.length, 1, "nothing left to load");
});
