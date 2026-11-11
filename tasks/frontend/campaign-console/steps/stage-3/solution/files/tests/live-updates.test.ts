// Stage 3, server side: one probe schedule for every dashboard, joined checks, and seq-numbered
// broadcasts with a snapshot that is consistent with them. Real sockets (Node's WebSocket) against
// createApp on a fake clock, with fake adapters that count their calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createApp, createStore } from "../src/index.ts";
import { FakeScheduler, flush } from "./helpers/fake-scheduler.ts";
import { fakeAdapter } from "./helpers/fake-platforms.ts";
import type { FakeAdapter } from "./helpers/fake-platforms.ts";
import type { App, PlatformRegistry, Seed } from "../src/index.ts";

const seed = (): Seed => JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8")) as Seed;
const apps: App[] = [];
const sockets: WebSocket[] = [];
after(async () => {
  for (const ws of sockets) ws.close();
  for (const app of apps) await app.close();
});

/** Lets sockets and promise chains make progress (real macrotasks). */
const turns = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A probe that waits until the test releases it. */
function gate() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return { released, release };
}

async function setup(adapters: Partial<Record<"google" | "meta" | "twilio" | "linkedin", FakeAdapter>> = {}) {
  const platforms = { google: fakeAdapter("google"), meta: fakeAdapter("meta"), twilio: fakeAdapter("twilio"), linkedin: fakeAdapter("linkedin"), ...adapters };
  const scheduler = new FakeScheduler();
  const store = createStore(seed());
  const app = createApp({ store, platforms: platforms as PlatformRegistry, scheduler, random: () => 0 });
  apps.push(app);
  const { url } = await app.listen(0);
  await turns();
  const probes = () => Object.values(platforms).reduce((n, p) => n + p.probes.length, 0);
  return { app, store, scheduler, url, platforms, probes };
}

interface Socket {
  ws: WebSocket;
  messages: any[];
  next(predicate: (m: any) => boolean): Promise<any>;
}

async function connect(url: string): Promise<Socket> {
  const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
  sockets.push(ws);
  const messages: any[] = [];
  const waiters: { predicate: (m: any) => boolean; resolve: (m: any) => void; seen: number }[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
    for (const w of [...waiters]) {
      const hit = messages.slice(w.seen).find(w.predicate);
      if (hit) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(hit);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let consumed = 0;
  return {
    ws,
    messages,
    next(predicate) {
      const index = messages.findIndex((m, i) => i >= consumed && predicate(m));
      if (index >= 0) {
        consumed = index + 1;
        return Promise.resolve(messages[index]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no matching message; got ${messages.map((m) => m.type)}`)), 2_000);
        waiters.push({
          predicate,
          seen: consumed,
          resolve: (m) => {
            clearTimeout(timer);
            consumed = messages.indexOf(m) + 1;
            resolve(m);
          },
        });
      });
    },
  };
}

test("one schedule: a round at listen and one per interval, whatever the number of dashboards; connecting calls no platform", async () => {
  const { url, scheduler, probes, store } = await setup();
  const connections = store.listConnections().length;
  assert.equal(probes(), connections, "the first round, as soon as the server listens");
  const dashboards = await Promise.all(Array.from({ length: 5 }, () => connect(url)));
  for (const d of dashboards) await d.next((m) => m.type === "snapshot");
  assert.equal(probes(), connections, "five dashboards connecting made no check");

  scheduler.advance(60_000);
  for (const d of dashboards) for (const c of store.listConnections()) await d.next((m) => m.type === "probe" && m.result.connectionId === c.id);
  assert.equal(probes(), 2 * connections, "one call per connection per interval, not one per dashboard");
});

test("checks of a connection already being checked join it: one platform call, one result for everyone, and rounds don't stack", async () => {
  const hold = gate();
  let held = false;
  const meta = fakeAdapter("meta", {
    probe: async () => {
      if (held) return;
      held = true;
      await hold.released;
    },
  });
  const { url, scheduler, platforms } = await setup({ meta });
  // The listen round's meta check is waiting on the gate.
  const [a, b] = [await connect(url), await connect(url)];
  await a.next((m) => m.type === "snapshot");
  await b.next((m) => m.type === "snapshot");
  for (let i = 0; i < 5; i++) a.ws.send(JSON.stringify({ type: "probe", connectionId: "conn_meta" }));
  b.ws.send(JSON.stringify({ type: "probe", connectionId: "conn_meta" }));
  scheduler.advance(60_000); // the next round joins too
  await turns();
  assert.equal(platforms.meta.probes.length, 1);

  hold.release();
  await a.next((m) => m.type === "probe" && m.result.connectionId === "conn_meta");
  await b.next((m) => m.type === "probe" && m.result.connectionId === "conn_meta");
  await turns();
  for (const d of [a, b]) assert.equal(d.messages.filter((m) => m.type === "probe" && m.result.connectionId === "conn_meta").length, 1);

  a.ws.send(JSON.stringify({ type: "probe", connectionId: "conn_meta" }));
  await a.next((m) => m.type === "probe" && m.result.connectionId === "conn_meta");
  assert.equal(platforms.meta.probes.length, 2, "once answered, the next request calls the platform again, at once");
});

test("broadcasts are numbered server-wide; a snapshot is current to its seq; an event during a connect is never lost or doubled", async () => {
  const { url, store } = await setup();
  const runId = store.listRuns()[0].id;
  const a = await connect(url);
  const first = await a.next((m) => m.type === "snapshot");
  store.appendEvent(runId, { at: 1, type: "sent", message: "one" });
  const pending = connect(url); // b connects while events keep coming
  store.appendEvent(runId, { at: 2, type: "sent", message: "two" });
  const b = await pending;
  const snapshot = await b.next((m) => m.type === "snapshot");
  assert.equal(b.messages[0].type, "snapshot", "the snapshot is the first message");
  const three = store.appendEvent(runId, { at: 3, type: "sent", message: "three" });
  await a.next((m) => m.type === "event" && m.event.id === three.id);
  await b.next((m) => m.type === "event" && m.event.id === three.id);

  const streamA = a.messages.slice(1);
  streamA.forEach((m, i) => assert.equal(m.seq, first.seq + 1 + i));
  const streamB = b.messages.slice(1);
  assert.deepEqual(streamB, streamA.filter((m) => m.seq > snapshot.seq), "b got exactly what a got after b's snapshot");
  for (const m of streamA.filter((m) => m.type === "event")) {
    const inSnapshot = snapshot.state.events[runId].some((e: any) => e.id === m.event.id);
    assert.equal(inSnapshot, m.seq <= snapshot.seq, `event ${m.event.id}: in the snapshot iff its seq is covered`);
  }
  assert.equal(snapshot.state.runs[runId].eventCount, store.listEvents(runId).length - 1);
});

test("close() stops the schedule even with a check in flight", async () => {
  const hold = gate();
  const twilio = fakeAdapter("twilio", { probe: () => hold.released });
  const { app, scheduler, probes } = await setup({ twilio });
  const calls = probes();
  await app.close();
  hold.release();
  await flush();
  await turns();
  scheduler.advance(10 * 60_000);
  assert.equal(probes(), calls);
  assert.equal(scheduler.pending, 0);
});
