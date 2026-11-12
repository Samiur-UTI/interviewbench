// Stage 3, "one probe per connection per interval, however many dashboards are open": createApp
// with fake platforms and ONE fake scheduler, real WebSocket dashboards (the app's own
// createDashboardClient), platform calls counted on the fakes. Every wait is "the next message of
// this kind within 2 s real time"; the fake clock only moves between those waits.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { within } from "./helpers/reconnect.ts";
import { PLATFORMS, buildSeed } from "./helpers/seed.ts";
import { createStack } from "./helpers/stack.ts";
import type { Dashboard, Stack, StackOptions } from "./helpers/stack.ts";

const INTERVAL = 60_000;
const IDS = PLATFORMS.map((p) => `conn_${p}`);

const stacks: Stack[] = [];
after(async () => {
  for (const s of stacks) await s.close();
});
async function stack(options: StackOptions = {}): Promise<Stack> {
  const s = await createStack({ seed: buildSeed(), ...options });
  stacks.push(s);
  return s;
}

const probeCounts = (s: Stack) => Object.fromEntries(PLATFORMS.map((p) => [p, s.fakes[p].count("probe")]));
const each = (n: number) => Object.fromEntries(PLATFORMS.map((p) => [p, n]));

async function dashboards(s: Stack, n: number): Promise<Dashboard[]> {
  const list: Dashboard[] = [];
  for (let i = 0; i < n; i++) list.push(await s.dashboard());
  return list;
}

/** Each dashboard sends a snapshot request and gets the answer: everything it sent before has been handled. */
async function roundTrip(list: Dashboard[]): Promise<void> {
  for (const d of list) d.ws.send({ type: "snapshot" });
  await Promise.all(list.map((d) => d.ws.next("snapshot")));
}

test("the server checks every connection when it starts listening and then once per interval, with no dashboard open; a dashboard that connects gets those results without a platform call", async () => {
  const s = await stack();
  assert.deepEqual(probeCounts(s), each(1), "a first round as soon as the server listens (no clock movement needed)");
  for (const id of IDS) assert.equal(s.store.getConnection(id).lastProbe?.ok, true, `${id}: the round's result is stored as lastProbe`);

  await s.scheduler.advance(INTERVAL - 1);
  assert.deepEqual(probeCounts(s), each(1), "nothing before probeIntervalMs");
  await s.scheduler.advance(1);
  assert.deepEqual(probeCounts(s), each(2), "the second round, probeIntervalMs after the first");

  const dash = await s.dashboard();
  assert.deepEqual(probeCounts(s), each(2), "connecting a dashboard calls no platform");
  for (const id of IDS) {
    assert.deepEqual(dash.snapshot.state.connections[id]?.lastProbe, s.store.getConnection(id).lastProbe, `${id}: the snapshot has the stored result`);
    assert.equal(dash.status(id), "connected");
  }
  await s.scheduler.advance(INTERVAL);
  assert.deepEqual(probeCounts(s), each(3));
});

test("20 open dashboards over three intervals: every connection is checked 4 times in all (the first round + 3), and every dashboard gets every result", async () => {
  const s = await stack();
  const list = await dashboards(s, 20);
  assert.deepEqual(probeCounts(s), each(1), "20 dashboards connecting made no platform call");

  for (let round = 1; round <= 3; round++) {
    await s.scheduler.advance(INTERVAL);
    for (const d of list) for (const id of IDS) assert.equal((await d.nextProbe(id)).result.ok, true);
    assert.deepEqual(probeCounts(s), each(1 + round), `after ${round} interval(s)`);
  }
  await roundTrip(list);
  for (const d of list) {
    const probes = d.ws.messages.filter((m) => m?.type === "probe");
    assert.equal(probes.length, 12, "each dashboard got the 4 results of each of the 3 rounds, once");
  }
  assert.deepEqual(probeCounts(s), each(4));
});

test("20 dashboards ask to check the same connection at once: one platform call, and the one result reaches every dashboard, also one that didn't ask", async () => {
  const s = await stack();
  const askers = await dashboards(s, 20);
  const [watcher] = await dashboards(s, 1);
  const gate = s.fakes.meta.defer("probe"); // the platform answers only when the test says so
  const before = s.fakes.meta.count("probe");
  const from = new Map([...askers, watcher].map((d) => [d, d.ws.messages.length]));

  for (const d of askers) d.ws.send({ type: "probe", connectionId: "conn_meta" });
  await roundTrip(askers); // every request has reached the server
  assert.ok(gate.reached, "the check went to the platform at once, without waiting for the clock");
  assert.equal(s.fakes.meta.count("probe"), before + 1, "requests for a connection whose check is in flight join it");

  gate.release("ok");
  const results = await Promise.all([...askers, watcher].map((d) => d.nextProbe("conn_meta")));
  for (const r of results) assert.deepEqual(r.result, results[0].result);
  assert.equal(results[0].result.ok, true);
  await roundTrip([...askers, watcher]);
  for (const d of [...askers, watcher]) {
    const metaProbes = d.ws.messages.slice(from.get(d)).filter((m) => m?.type === "probe" && m.result?.connectionId === "conn_meta");
    assert.equal(metaProbes.length, 1, "one result per dashboard, not one per request");
    assert.equal(d.status("conn_meta"), "connected");
  }
  assert.equal(s.fakes.meta.count("probe"), before + 1);
});

test("a round doesn't call a platform again while that connection's check is still in flight: it joins the check, and the next round calls again", async () => {
  const s = await stack();
  const dash = await s.dashboard();
  const others = IDS.filter((id) => id !== "conn_linkfolio");
  const gate = s.fakes.linkfolio.defer("probe");

  await s.scheduler.advance(INTERVAL); // round 2: Linkfolio's check hangs
  await within(gate.started, 2_000, "round 2's Linkfolio check");
  for (const id of others) await dash.nextProbe(id);
  assert.equal(s.fakes.linkfolio.count("probe"), 2);

  await s.scheduler.advance(INTERVAL); // round 3: still in flight
  for (const id of others) await dash.nextProbe(id); // the round did happen for the others
  assert.equal(s.fakes.linkfolio.count("probe"), 2, "no second call while the first is unanswered");
  for (const p of PLATFORMS.filter((p) => p !== "linkfolio")) assert.equal(s.fakes[p].count("probe"), 3, `${p}: a hanging check elsewhere doesn't hold up its rounds`);

  gate.release("ok");
  assert.equal((await dash.nextProbe("conn_linkfolio")).result.ok, true);
  await s.scheduler.advance(INTERVAL); // round 4
  await dash.nextProbe("conn_linkfolio");
  assert.equal(s.fakes.linkfolio.count("probe"), 3, "the next round calls the platform again");
  const linkfolioResults = dash.ws.messages.filter((m) => m?.type === "probe" && m.result?.connectionId === "conn_linkfolio");
  assert.equal(linkfolioResults.length, 2, "the joined check's result was pushed once, then round 4's");
});

test("close() stops the schedule for good, even with a check in flight: no platform call and no timer afterwards", async () => {
  const s = await stack();
  const gate = s.fakes.twilio.defer("probe");
  await s.scheduler.advance(INTERVAL);
  await within(gate.started, 2_000, "the next round's Twilio check, with no dashboard open");
  const calls = s.fakes.count("probe");

  await s.server.close();
  gate.release("ok");
  await s.scheduler.settle(10);
  await s.scheduler.advance(5 * INTERVAL);
  assert.equal(s.fakes.count("probe"), calls, "no check after close()");
  assert.equal(s.scheduler.pending, 0, "no timer left behind");
});
