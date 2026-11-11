import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NotFoundError, createStore } from "../src/index.ts";
import type { Seed, StoreChange } from "../src/index.ts";

const seed = (): Seed => JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8")) as Seed;

test("loads the seed: one connection per platform, campaigns, runs and their events", () => {
  const store = createStore(seed());
  assert.deepEqual(
    store.listConnections().map((c) => c.platform),
    ["google", "meta", "twilio", "linkedin"],
  );
  assert.equal(store.listCampaigns().length, 3);
  assert.deepEqual(
    store.listEvents("run_1").map((e) => e.id),
    [1, 2, 3, 4],
  );
  assert.deepEqual(store.listEvents("run_unknown"), []);
});

test("appended events get the run's next id and are listed oldest first", () => {
  const store = createStore(seed());
  const a = store.appendEvent("run_2", { at: 1, type: "sent", message: "a" });
  const b = store.appendEvent("run_2", { at: 2, type: "sent", message: "b" });
  assert.deepEqual([a.id, b.id, a.runId], [4, 5, "run_2"]);
  const ids = store.listEvents("run_2").map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
});

test("update replaces the record and leaves earlier reads untouched", () => {
  const store = createStore(seed());
  const before = store.getRun("run_2")!;
  const after = store.updateRun("run_2", { status: "paused", pausedReason: "user" });
  assert.equal(before.status, "running");
  assert.equal(after.status, "paused");
  assert.equal(store.getRun("run_2")!.pausedReason, "user");
});

test("unknown records throw NotFoundError on update and append", () => {
  const store = createStore(seed());
  assert.throws(() => store.updateConnection("conn_nope", { label: "x" }), NotFoundError);
  assert.throws(() => store.appendEvent("run_nope", { at: 1, type: "sent", message: "x" }), NotFoundError);
});

test("listeners hear about every change after it is stored, until they unsubscribe", () => {
  const store = createStore(seed());
  const seen: string[] = [];
  const off = store.on((change: StoreChange) => {
    if (change.kind === "event") seen.push(`event ${change.runId}#${change.event.id} (${store.listEvents(change.runId).length})`);
    else if (change.kind === "run") seen.push(`run ${change.run.id} ${change.run.status}`);
    else seen.push(`connection ${change.connection.id}`);
  });
  store.updateRun("run_3", { status: "completed" });
  store.appendEvent("run_3", { at: 1, type: "completed", message: "done" });
  store.updateConnection("conn_meta", { label: "Meta Ads" });
  off();
  store.updateRun("run_3", { status: "failed" });
  assert.deepEqual(seen, ["run run_3 completed", "event run_3#2 (2)", "connection conn_meta"]);
});

test("the store doesn't share objects with its seed", () => {
  const data = seed();
  const store = createStore(data);
  data.runs[0].status = "failed";
  assert.equal(store.getRun("run_1")!.status, "completed");
});
