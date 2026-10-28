import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { FlightSearchService, handleSearch, NoSuppliersAvailableError, ValidationError } from "../src/index.ts";
import type { SearchRequest, SupplierClient, SupplierFormat } from "../src/index.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function fakeClient(name: string, format: SupplierFormat, raw: string): SupplierClient & { calls: number } {
  return {
    name,
    format,
    calls: 0,
    async search() {
      this.calls++;
      return raw;
    },
  };
}

const request = (passengers = 1): SearchRequest => ({
  tripType: "return",
  legs: [
    { origin: "LHR", destination: "DXB", date: "2026-12-01" },
    { origin: "DXB", destination: "LHR", date: "2026-12-10" },
  ],
  passengers,
});

const service = () =>
  new FlightSearchService([
    fakeClient("aerolink", "aerolink", fixture("aerolink-lhr-dxb.json")),
    fakeClient("skymesh", "skymesh", fixture("skymesh-lhr-dxb.json")),
  ]);

test("search merges every supplier's offers", async () => {
  const results = await service().search(request());
  assert.deepEqual(
    results.map((it) => it.id),
    ["skymesh:SM-55102", "aerolink:AL-000124", "skymesh:SM-55103"],
  );
});

test("offers without enough seats are hidden", async () => {
  const results = await service().search(request(2));
  assert.ok(!results.some((it) => it.id === "aerolink:AL-000124"));
});

test("invalid requests are rejected before asking suppliers", async () => {
  const client = fakeClient("aerolink", "aerolink", fixture("aerolink-lhr-dxb.json"));
  const svc = new FlightSearchService([client]);
  await assert.rejects(async () => svc.search({ ...request(), passengers: 0 }), ValidationError);
  assert.equal(client.calls, 0);
});

test("the HTTP handler maps results and validation errors", async () => {
  const ok = await handleSearch(service(), request());
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { itineraries: unknown[] }).itineraries.length, 3);
  const bad = await handleSearch(service(), { tripType: "oneway", legs: [], passengers: 1 });
  assert.equal(bad.status, 400);
});

// --- Stage 2: deadlines, cancellation and partial results ----------------------------------

/** A client whose calls settle only when the test says so. */
function controlledClient(name: string, format: SupplierFormat) {
  const calls: { signal?: AbortSignal; resolve: (raw: string) => void; reject: (e: unknown) => void }[] = [];
  const client: SupplierClient = {
    name,
    format,
    search: (_req, signal) => new Promise<string>((resolve, reject) => calls.push({ signal, resolve, reject })),
  };
  return { client, calls };
}

const failing = (name: string, format: SupplierFormat): SupplierClient => ({
  name,
  format,
  search: async () => {
    throw new Error("HTTP 500");
  },
});

const al = () => fakeClient("aerolink", "aerolink", fixture("aerolink-lhr-dxb.json"));
const sm = () => fakeClient("skymesh", "skymesh", fixture("skymesh-lhr-dxb.json"));

test("searchWithStatus reports every supplier in client order", async () => {
  const result = await new FlightSearchService([al(), sm()]).searchWithStatus(request());
  assert.equal(result.partial, false);
  assert.deepEqual(result.suppliers, [
    { supplier: "aerolink", status: "ok", offers: 2 },
    { supplier: "skymesh", status: "ok", offers: 2 },
  ]);
});

test("all suppliers are asked before any answers", async () => {
  const a = controlledClient("aerolink", "aerolink");
  const b = controlledClient("skymesh", "skymesh");
  const pending = new FlightSearchService([a.client, b.client]).searchWithStatus(request());
  await new Promise((r) => setImmediate(r));
  assert.equal(a.calls.length + b.calls.length, 2);
  a.calls[0].resolve(fixture("aerolink-lhr-dxb.json"));
  b.calls[0].resolve(fixture("skymesh-lhr-dxb.json"));
  assert.equal((await pending).partial, false);
});

test("a failing supplier gives partial results", async () => {
  const result = await new FlightSearchService([failing("aerolink", "aerolink"), sm()]).searchWithStatus(request());
  assert.equal(result.partial, true);
  assert.equal(result.suppliers[0].status, "error");
  assert.deepEqual(result.itineraries.map((it) => it.id), ["skymesh:SM-55102", "skymesh:SM-55103"]);
});

test("a slow supplier times out, is aborted, and its late answer is ignored", async () => {
  const slow = controlledClient("skymesh", "skymesh");
  const result = await new FlightSearchService([al(), slow.client]).searchWithStatus(request(), { timeoutMs: 20 });
  assert.equal(result.suppliers[1].status, "timeout");
  assert.equal(slow.calls[0].signal?.aborted, true);
  const before = structuredClone(result);
  slow.calls[0].resolve(fixture("skymesh-lhr-dxb.json"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(result, before);
});

test("the caller aborting cancels every supplier call and leaves no listener behind", async () => {
  const a = controlledClient("aerolink", "aerolink");
  const controller = new AbortController();
  const pending = new FlightSearchService([a.client]).searchWithStatus(request(), { signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  const reason = new Error("user left");
  controller.abort(reason);
  await assert.rejects(async () => pending, (err) => err === reason);
  assert.equal(a.calls[0].signal?.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an already-aborted signal makes no supplier calls", async () => {
  const a = al();
  const reason = new Error("gone");
  await assert.rejects(async () => new FlightSearchService([a]).searchWithStatus(request(), { signal: AbortSignal.abort(reason) }), (e) => e === reason);
  assert.equal(a.calls, 0);
});

test("invalid timeouts are rejected before any call", async () => {
  const a = al();
  const svc = new FlightSearchService([a]);
  for (const timeoutMs of [0, -1, 1.5, 30_001, Number.NaN]) {
    await assert.rejects(async () => svc.searchWithStatus(request(), { timeoutMs }), ValidationError);
  }
  assert.equal(a.calls, 0);
  assert.throws(() => new FlightSearchService([a], { defaultTimeoutMs: 0 }), ValidationError);
});

test("when every supplier fails: no empty 200", async () => {
  const svc = new FlightSearchService([failing("aerolink", "aerolink"), failing("skymesh", "skymesh")]);
  const result = await svc.searchWithStatus(request());
  assert.deepEqual(result.itineraries, []);
  assert.equal(result.partial, true);
  await assert.rejects(async () => svc.search(request()), NoSuppliersAvailableError);
  const http = await handleSearch(svc, request());
  assert.equal(http.status, 503);
});
