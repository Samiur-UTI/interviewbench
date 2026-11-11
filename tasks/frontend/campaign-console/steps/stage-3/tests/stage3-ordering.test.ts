// Stage 3, "nothing lost, nothing twice, no re-requests": the seq contract on the wire, a dashboard
// connecting while things happen, and what the user ends up seeing (the app's own
// createDashboardClient behind a real WebSocket, on the server's fake scheduler).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { within } from "./helpers/reconnect.ts";
import { NOW, buildSeed, makeEvents, makeRun } from "./helpers/seed.ts";
import { createStack, runUntilSettled } from "./helpers/stack.ts";
import { WsClient } from "./helpers/ws-client.ts";
import type { Dashboard, Stack } from "./helpers/stack.ts";

const stacks: Stack[] = [];
after(async () => {
  for (const s of stacks) await s.close();
});
async function stack(seed: any): Promise<Stack> {
  const s = await createStack({ seed });
  stacks.push(s);
  return s;
}

/** Messages received after the dashboard's first snapshot, without errors and later snapshots. */
const broadcasts = (d: Dashboard) => d.ws.messages.slice(1).filter((m) => m?.type !== "snapshot" && m?.type !== "error");

/**
 * Sends a snapshot request and waits until every snapshot the dashboard asked for has arrived:
 * everything broadcast before the request has arrived too. Returns the last snapshot.
 */
async function sync(d: Dashboard): Promise<any> {
  d.ws.send({ type: "snapshot" });
  await d.settle();
  return d.ws.messages.filter((m) => m?.type === "snapshot").at(-1);
}

/** A fresh dashboard's view of the server right now (a plain socket, its first message). */
async function freshSnapshot(s: Stack): Promise<any> {
  const ws = await WsClient.open(`${s.url}/ws`);
  try {
    return await ws.next("snapshot");
  } finally {
    await ws.close();
  }
}

/** Polls (real time, a macrotask at a time) until `predicate` holds. */
async function waitFor(predicate: () => boolean, what: string, deadlineMs = 2_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${deadlineMs} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function assertConsecutive(list: any[], after: number, label: string): void {
  list.forEach((m, i) => assert.equal(m.seq, after + 1 + i, `${label}: message ${i} (${m.type}) has seq ${m.seq}, expected ${after + 1 + i}`));
}

test("every message after the snapshot is numbered: seq is the same on every dashboard, one higher each time, and continues from the snapshot's", async () => {
  const s = await stack(buildSeed({ runs: [makeRun({ id: "run_t", platform: "twilio", items: 6, status: "running" })] }));
  const a = await s.dashboard();
  assert.equal(a.ws.messages[0]?.type, "snapshot", "a dashboard's first message is its snapshot");
  assert.ok(Number.isInteger(a.snapshot.seq) && a.snapshot.seq >= 0, `snapshot seq: ${a.snapshot.seq}`);

  s.fakes.twilio.script("send", "ok", "ok");
  const gate = s.fakes.twilio.defer("send"); // the third message waits
  const running = runUntilSettled(s.server.runner.start("run_t"), s.scheduler);
  await within(gate.started, 2_000, "the run's third send");
  const b = await s.dashboard(); // connects after the first broadcasts
  assert.equal(b.ws.messages[0]?.type, "snapshot");
  assert.ok(b.snapshot.seq > a.snapshot.seq, "b's snapshot reflects the broadcasts so far");
  gate.release("ok");
  assert.equal((await running).error, undefined);

  a.ws.send({ type: "probe", connectionId: "conn_meta" });
  a.ws.send("not json"); // an answer to a alone
  await a.ws.next("error");
  for (const d of [a, b]) {
    await d.ws.next((m) => m?.type === "run" && m.run?.status === "completed");
    await d.nextProbe("conn_meta");
  }
  const [endA, endB] = [await sync(a), await sync(b)];

  const seenA = broadcasts(a);
  const seenB = broadcasts(b);
  for (const m of [...seenA, ...seenB]) assert.ok(["probe", "run", "event", "connection"].includes(m.type), `unexpected ${m.type} after the snapshot`);
  assertConsecutive(seenA, a.snapshot.seq, "a");
  assertConsecutive(seenB, b.snapshot.seq, "b");
  assert.deepEqual(seenB, seenA.filter((m) => m.seq > b.snapshot.seq), "b got exactly what a got after b's snapshot, with the same seq");
  assert.equal(endA.seq, seenA.at(-1).seq, "a later snapshot carries the seq of the last broadcast");
  assert.equal(endB.seq, endA.seq);
});

test("a dashboard that connects mid-run gets each change once: what its snapshot's seq covers is in the snapshot, everything after reaches it", async () => {
  const s = await stack(buildSeed({ runs: [makeRun({ id: "run_t", platform: "twilio", items: 8, status: "running" })] }));
  const a = await s.dashboard();
  s.fakes.twilio.script("send", "ok", "ok", "ok");
  const gate = s.fakes.twilio.defer("send");
  const running = runUntilSettled(s.server.runner.start("run_t"), s.scheduler);
  await within(gate.started, 2_000, "the run's fourth send");
  const b = await s.dashboard();
  gate.release("ok");
  assert.equal((await running).error, undefined);
  for (const d of [a, b]) await d.ws.next((m) => m?.type === "run" && m.run?.status === "completed");
  await sync(a);
  await sync(b);

  const cut = b.snapshot.seq;
  const before = broadcasts(a).filter((m) => m.seq <= cut);
  const afterCut = broadcasts(a).filter((m) => m.seq > cut);
  assert.ok(before.some((m) => m.type === "event") && afterCut.some((m) => m.type === "event"), "b connected while events were being recorded");

  const inSnapshot = new Set((b.snapshot.state.events.run_t ?? []).map((e: any) => e.id));
  for (const m of before.filter((m) => m.type === "event")) assert.ok(inSnapshot.has(m.event.id), `event ${m.event.id} (seq ${m.seq}) is in b's snapshot`);
  for (const m of afterCut.filter((m) => m.type === "event")) assert.ok(!inSnapshot.has(m.event.id), `event ${m.event.id} (seq ${m.seq}) is not in b's snapshot`);
  const { eventCount, ...run } = b.snapshot.state.runs.run_t;
  const { eventCount: _, ...lastRun } = before.filter((m) => m.type === "run").at(-1).run;
  assert.deepEqual(run, lastRun, "the snapshot's run is the last run broadcast its seq covers");
  assert.equal(eventCount, before.filter((m) => m.type === "event").length, "and counts the events its seq covers");
  assert.deepEqual(broadcasts(b), afterCut, "b's stream is exactly a's after the cut");

  const ids = b.client.state().events.run_t.map((e: any) => e.id);
  assert.deepEqual(ids, [...new Set(ids)].sort((x: number, y: number) => x - y), "b holds each event once, in order");
  assert.equal(ids.length, s.store.listEvents("run_t").length);
  assert.equal(b.client.state().runs.run_t.status, "completed");
});

test("an event recorded while a dashboard is connecting is shown exactly once: in its snapshot or in a message after it", async () => {
  const s = await stack(buildSeed({ runs: [makeRun({ id: "run_x", platform: "twilio", items: 3, status: "completed", nextIndex: 3 })], events: makeEvents("run_x", 3) }));
  // If the server checks connections for a new dashboard, the first such check waits here.
  const gate = s.fakes.google.defer("probe");
  const dash = await s.dashboard({ awaitSnapshot: false });
  await waitFor(() => gate.reached || dash.ws.messages.some((m) => m?.type === "snapshot"), "the dashboard is being set up");
  const late = s.store.appendEvent("run_x", { at: NOW, type: "sent", message: "Item sent to Late Target", target: { name: "Late Target" } });
  gate.release("ok");

  const snapshot = await dash.ws.next("snapshot");
  assert.equal(dash.ws.messages[0]?.type, "snapshot", "nothing reaches a dashboard before its snapshot");
  const marker = s.store.appendEvent("run_x", { at: NOW, type: "sent", message: "Item sent to Marker", target: { name: "Marker" } });
  await dash.ws.next((m) => m?.type === "event" && m.event?.id === marker.id);
  await dash.settle();

  const inSnapshot = (snapshot.state.events.run_x ?? []).filter((e: any) => e.id === late.id).length;
  const inStream = dash.ws.messages.slice(1).filter((m) => m?.type === "event" && m.event?.id === late.id).length;
  assert.equal(inSnapshot + inStream, 1, `the late event: ${inSnapshot} in the snapshot, ${inStream} in the stream`);
  const held = dash.client.state().events.run_x.filter((e: any) => e.id === late.id);
  assert.equal(held.length, 1, "the dashboard shows it once");
  assert.equal(dash.client.state().runs.run_x.eventCount, 5, "and counts it: 3 seeded, the late one and the marker");
});

test("after a run of 50+ messages the dashboard's state is a fresh snapshot's (plus older events it saw live), without asking for a single snapshot", async () => {
  const s = await stack(
    buildSeed({
      runs: [makeRun({ id: "run_c", platform: "twilio", items: 25, status: "running" }), makeRun({ id: "run_old", platform: "meta", items: 2, status: "completed", nextIndex: 2 })],
      events: makeEvents("run_old", 30),
    }),
  );
  const dash = await s.dashboard();
  const settled = await runUntilSettled(s.server.runner.start("run_c"), s.scheduler);
  assert.equal(settled.error, undefined, String(settled.error));
  dash.ws.send({ type: "probe", connectionId: "conn_meta" });
  await dash.ws.next((m) => m?.type === "run" && m.run?.id === "run_c" && m.run.status === "completed");
  await dash.nextProbe("conn_meta");
  await dash.settle();
  assert.ok(broadcasts(dash).length >= 50, `${broadcasts(dash).length} messages`);
  assert.equal(dash.ws.sent.filter((m: any) => m?.type === "snapshot").length, 0, "no snapshot was asked for");

  const fresh = (await freshSnapshot(s)).state;
  const mine = dash.client.state();
  const total = s.store.listEvents("run_c").length;
  assert.ok(total > 20);
  assert.equal(fresh.runs.run_c.eventCount, total, "the snapshot counts every event of the run");
  assert.equal(fresh.events.run_c.length, 20, "but carries only the newest 20");
  assert.deepEqual(mine.connections, fresh.connections);
  assert.deepEqual(mine.campaigns, fresh.campaigns);
  assert.deepEqual(mine.runs, fresh.runs, "runs, eventCount included");
  for (const [runId, list] of Object.entries(fresh.events) as [string, any[]][]) {
    const held = mine.events[runId] ?? [];
    assert.deepEqual(held.slice(held.length - list.length), list, `${runId}: the snapshot's events are the newest the dashboard holds`);
    const ids = held.map((e: any) => e.id);
    assert.deepEqual(ids, [...new Set(ids)].sort((x: number, y: number) => x - y), `${runId}: once each, ascending`);
  }
  assert.equal(mine.events.run_c.length, total, "the dashboard kept every event it saw happen");
});
