// Stage 3, "recent events only": what the page, /api/dashboard and snapshots carry for a long run,
// GET /api/runs/:id/events, and loading earlier events from the dashboard (the app's own
// createDashboardClient with its real fetch against the server). Budgets are byte counts.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadApp, loadRender } from "./helpers/app.ts";
import { leaks, parseState, withoutState } from "./helpers/browser.ts";
import { elements, textOf } from "./helpers/markup.ts";
import { buildSeed, makeEvents, makeRun, storedDiagnosticsEvent } from "./helpers/seed.ts";
import { createStack } from "./helpers/stack.ts";
import type { Stack, StackOptions } from "./helpers/stack.ts";

const stacks: Stack[] = [];
after(async () => {
  for (const s of stacks) await s.close();
});
async function stack(seed: any, options: StackOptions = {}): Promise<Stack> {
  const s = await createStack({ seed, ...options });
  stacks.push(s);
  return s;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const ids = (events: any[] | undefined) => (events ?? []).map((e) => e.id);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** A completed Twilio run with `count` events (ids 1..count). */
function longRun(id: string, count: number) {
  return { run: makeRun({ id, platform: "twilio", items: 2, status: "completed", nextIndex: 2 }), events: makeEvents(id, count) };
}

async function getJson(url: string): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(url);
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

const loadButtons = (markup: string) => elements(markup, "button").filter((b) => /load earlier events/i.test(textOf(markup, b)));

test("a run with 5,000 events: the snapshot, /api/dashboard and the page carry its 20 newest and its total, within their byte budgets", async () => {
  const big = longRun("run_big", 5_000);
  const s = await stack(buildSeed({ runs: [big.run], events: big.events }));
  const dash = await s.dashboard();

  const snapshotBytes = bytes(JSON.stringify(dash.snapshot));
  assert.ok(snapshotBytes < 100_000, `snapshot: ${snapshotBytes} bytes`);
  assert.deepEqual(ids(dash.snapshot.state.events.run_big), range(4_981, 5_000), "the snapshot: the 20 newest, oldest first");
  assert.equal(dash.snapshot.state.runs.run_big.eventCount, 5_000);

  const api = await getJson(`${s.url}/api/dashboard`);
  assert.ok(bytes(api.text) < 100_000, `/api/dashboard: ${bytes(api.text)} bytes`);
  assert.deepEqual(ids(api.body.events.run_big), range(4_981, 5_000));
  assert.equal(api.body.runs.run_big.eventCount, 5_000);

  const page = await (await fetch(`${s.url}/dashboard`)).text();
  assert.ok(bytes(page) < 150_000, `page: ${bytes(page)} bytes`);
  const state = parseState(page);
  assert.deepEqual(ids(state.events.run_big), range(4_981, 5_000), "the page's state: the 20 newest");
  assert.equal(state.runs.run_big.eventCount, 5_000);
  const markup = withoutState(page);
  const shown = new Set([...markup.matchAll(/Target (\d+)/g)].map((m) => Number(m[1])));
  assert.deepEqual([...shown].sort((a, b) => a - b), range(4_981, 5_000), "the page shows exactly the 20 newest events");
  assert.equal(loadButtons(markup).length, 1, 'a "Load earlier events" button for the run');
});

test("config.dashboard.recentEvents is the config the app is created with", async () => {
  const app = await loadApp();
  const config = { ...app.config, dashboard: { ...app.config.dashboard, recentEvents: 7 } };
  const run = longRun("run_r", 30);
  const s = await stack(buildSeed({ runs: [run.run], events: run.events }), { config });
  const dash = await s.dashboard();
  assert.deepEqual(ids(dash.snapshot.state.events.run_r), range(24, 30), "snapshot");
  const api = await getJson(`${s.url}/api/dashboard`);
  assert.deepEqual(ids(api.body.events.run_r), range(24, 30), "/api/dashboard");
  const page = await (await fetch(`${s.url}/dashboard`)).text();
  assert.deepEqual(ids(parseState(page).events.run_r), range(24, 30), "page");
  assert.equal(parseState(page).runs.run_r.eventCount, 30);
});

test("GET /api/runs/:id/events pages backwards through all 5,000 events: ascending pages, ids below `before`, nothing twice, nothing skipped", async () => {
  const big = longRun("run_big", 5_000);
  const s = await stack(buildSeed({ runs: [big.run], events: big.events }));
  const base = `${s.url}/api/runs/run_big/events`;

  const newest = await getJson(base);
  assert.equal(newest.status, 200, newest.text);
  assert.deepEqual(ids(newest.body.events), range(4_951, 5_000), "no before: the newest page; no limit: 50");
  assert.equal(newest.body.nextBefore, 4_951);
  assert.deepEqual(newest.body.events.at(-1), { id: 5_000, runId: "run_big", at: big.events[4_999].at, type: "sent", message: "Item sent to Target 5000", target: { name: "Target 5000" } });

  const seen: number[] = [];
  let before: number | null = null;
  let pages = 0;
  do {
    const r = await getJson(`${base}?limit=200${before === null ? "" : `&before=${before}`}`);
    assert.equal(r.status, 200, r.text);
    const page = ids(r.body.events);
    assert.ok(page.length > 0 && page.length <= 200, `page of ${page.length}`);
    assert.deepEqual(page, [...page].sort((a, b) => a - b), "each page is ascending");
    if (before !== null) assert.ok(page.every((id) => id < before!), `ids below before=${before}`);
    seen.unshift(...page);
    before = r.body.nextBefore;
    assert.ok(before === null || before === page[0], `nextBefore is the oldest id returned: ${before}`);
    pages += 1;
  } while (before !== null && pages < 100);
  assert.equal(pages, 25);
  assert.deepEqual(seen, range(1, 5_000), "every event exactly once");

  const last = await getJson(`${base}?before=51&limit=50`);
  assert.deepEqual([ids(last.body.events), last.body.nextBefore], [range(1, 50), null], "the page that reaches the first event ends the walk");
  const empty = await getJson(`${base}?before=1`);
  assert.deepEqual([empty.status, empty.body.events, empty.body.nextBefore], [200, [], null]);
  const beyond = await getJson(`${base}?before=999999&limit=3`);
  assert.deepEqual([ids(beyond.body.events), beyond.body.nextBefore], [range(4_998, 5_000), 4_998]);
});

test("GET /api/runs/:id/events refuses what isn't a positive integer, a limit over 200, and runs that don't exist", async () => {
  const run = longRun("run_v", 10);
  const s = await stack(buildSeed({ runs: [run.run], events: run.events }));
  const base = `${s.url}/api/runs/run_v/events`;
  const missing = await getJson(`${s.url}/api/runs/run_nope/events`);
  assert.deepEqual([missing.status, missing.body], [404, { error: "not_found" }]);

  for (const [query, field] of [
    ["before=0", "before"],
    ["before=-3", "before"],
    ["before=2.5", "before"],
    ["before=abc", "before"],
    ["before=", "before"],
    ["limit=0", "limit"],
    ["limit=201", "limit"],
    ["limit=1.5", "limit"],
    ["limit=ten", "limit"],
    ["limit=", "limit"],
  ]) {
    const r = await getJson(`${base}?${query}`);
    assert.deepEqual([r.status, r.body], [400, { error: "invalid_query", field }], `?${query}: ${r.status} ${r.text}`);
  }
  const max = await getJson(`${base}?limit=200`);
  assert.deepEqual([max.status, ids(max.body.events), max.body.nextBefore], [200, range(1, 10), null]);
  const one = await getJson(`${base}?limit=1&before=5`);
  assert.deepEqual([ids(one.body.events), one.body.nextBefore], [[4], 4]);
});

test("events from the paging API carry no adapter details and no secret", async () => {
  const run = makeRun({ id: "run_d", platform: "twilio", items: 2, status: "completed", nextIndex: 2 });
  const events = [...makeEvents("run_d", 40), storedDiagnosticsEvent("run_d", 41), ...makeEvents("run_d", 30, { from: 42 })];
  const s = await stack(buildSeed({ runs: [run], events }));
  const texts: string[] = [];
  let before: number | null = null;
  do {
    const r = await getJson(`${s.url}/api/runs/run_d/events?limit=20${before === null ? "" : `&before=${before}`}`);
    texts.push(r.text);
    for (const e of r.body.events) assert.equal("detail" in e, false, `event ${e.id} has no detail`);
    before = r.body.nextBefore;
  } while (before !== null && texts.length < 20);
  assert.ok(texts.some((t) => t.includes('"id":41')), "the stored diagnostics event is listed");
  assert.deepEqual(leaks(texts.join("\n"), s.secrets()), []);
});

test('"Load earlier events" in a dashboard: each load adds the events just before the oldest one shown, in order, once, until the button goes away', async () => {
  const run = longRun("run_l", 130);
  const s = await stack(buildSeed({ runs: [run.run], events: run.events }));
  const dash = await s.dashboard();
  const { renderToString } = await loadRender();
  const render = () => renderToString(s.client.html`<${s.client.Dashboard} state=${dash.client.state()} statusOf=${dash.client.statusOf} />`);
  const held = () => ids(dash.client.state().events.run_l);
  const contiguousTo130 = (list: number[]) => list.length > 0 && list.at(-1) === 130 && list.every((id, i) => i === 0 || id === list[i - 1] + 1);

  assert.deepEqual(held(), range(111, 130));
  assert.equal(loadButtons(render()).length, 1, "the button, while events are missing");

  await Promise.all([dash.client.loadEarlierEvents("run_l"), dash.client.loadEarlierEvents("run_l")]); // a double click
  const once = held();
  assert.ok(once.length > 20 && contiguousTo130(once), `after a double load: ${once[0]}..${once.at(-1)} (${once.length})`);

  for (let i = 0; i < 130 && held()[0] !== 1; i++) {
    const length = held().length;
    await dash.client.loadEarlierEvents("run_l");
    assert.ok(held().length > length, "every load adds earlier events");
    assert.ok(contiguousTo130(held()));
  }
  assert.deepEqual(held(), range(1, 130), "all of them, once each, oldest first");
  assert.equal(loadButtons(render()).length, 0, "no button once every event is shown");
  await dash.client.loadEarlierEvents("run_l");
  assert.deepEqual(held(), range(1, 130), "loading again changes nothing");
});
