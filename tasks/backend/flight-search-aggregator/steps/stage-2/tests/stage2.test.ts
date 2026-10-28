// Stage 2 hidden tests: concurrent fan-out, one deadline, cancellation through AbortSignal,
// partial results, 503 when every supplier fails, and nothing left running afterwards.
// The fakes never use timers; only the service's own deadline does, and tests assert upper bounds.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { after, test } from "node:test";
import { runChild } from "./helpers/child.ts";
import { loadApp } from "./helpers/app.ts";
import { deferred, neverResolving, rejecting, resolving, tick } from "./helpers/fakes.ts";
import type { FakeClient } from "./helpers/fakes.ts";
import { ANY_REQUEST, aeroLinkRaw, genMarket, skyMeshRaw, toItineraries } from "./helpers/payloads.ts";
import type { GenOffer } from "./helpers/payloads.ts";
import { referenceSearch } from "./helpers/reference.ts";

const services: { close?: () => Promise<void> }[] = [];
after(async () => {
  for (const s of services) if (typeof s.close === "function") await s.close();
});

async function service(clients: FakeClient[], options?: object) {
  const app = await loadApp();
  const svc = options === undefined ? new app.FlightSearchService(clients) : new app.FlightSearchService(clients, options);
  services.push(svc);
  return { app, svc };
}

const [MA, MS, MB] = genMarket(31, 90, 3);
const RAW = { aerolink: aeroLinkRaw(MA), skymesh: skyMeshRaw(MS), aerolinkB: aeroLinkRaw(MB, { seed: 9 }) };
const okAerolink = () => resolving("aerolink", "aerolink", RAW.aerolink);
const okSkymesh = () => resolving("skymesh", "skymesh", RAW.skymesh);
const okAerolinkB = () => resolving("aerolink-b", "aerolink", RAW.aerolinkB);
const expected = (parts: [string, GenOffer[]][], passengers = 1) =>
  referenceSearch(parts.map(([name, offers]) => ({ name, itineraries: toItineraries(offers, name) })), passengers);
const request = (passengers = 1) => ({ ...ANY_REQUEST, passengers });
const statuses = (r: { suppliers: { supplier: string; status: string }[] }) => r.suppliers.map((s) => `${s.supplier}:${s.status}`);

/** Records unhandled rejections while `fn` runs (and a few turns of the event loop after it). */
async function noUnhandledRejections(fn: () => Promise<void>) {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await fn();
    for (let i = 0; i < 5; i++) await tick();
  } finally {
    process.off("unhandledRejection", listener);
  }
  assert.deepEqual(seen, [], "unhandled rejection");
}

test("s2 all suppliers ok", async () => {
  const { app, svc } = await service([okAerolink(), okSkymesh(), okAerolinkB()]);
  const result = await svc.searchWithStatus(request(2));
  assert.equal(result.partial, false);
  assert.deepEqual(
    result.suppliers.map((s: { supplier: string; status: string; offers: number }) => [s.supplier, s.status, s.offers]),
    [
      ["aerolink", "ok", MA.length],
      ["skymesh", "ok", MS.length],
      ["aerolink-b", "ok", MB.length],
    ],
  );
  assert.deepEqual(result.itineraries, expected([["aerolink", MA], ["skymesh", MS], ["aerolink-b", MB]], 2));
  const http = await app.handleSearch(svc, request(2));
  assert.equal(http.status, 200);
  assert.deepEqual(Object.keys(http.body).sort(), ["itineraries", "partial", "suppliers"]);
});

test("s2 suppliers are called concurrently", async () => {
  const fakes = [deferred("aerolink", "aerolink"), deferred("skymesh", "skymesh"), deferred("aerolink-b", "aerolink")];
  const { svc } = await service(fakes.map((f) => f.client));
  const pending = svc.searchWithStatus(request(), { timeoutMs: 30_000 });
  await tick();
  assert.deepEqual(fakes.map((f) => f.client.calls.length), [1, 1, 1], "every supplier is asked before any answers");
  fakes[0].resolve(RAW.aerolink);
  fakes[1].resolve(RAW.skymesh);
  fakes[2].resolve(RAW.aerolinkB);
  const result = await pending;
  assert.equal(result.partial, false);
});

test("s2 a rejecting supplier does not sink the search", async () => {
  const { svc } = await service([okAerolink(), rejecting("skymesh", "skymesh", new Error("HTTP 500 from supplier")), okAerolinkB()]);
  const result = await svc.searchWithStatus(request());
  assert.equal(result.partial, true);
  assert.deepEqual(statuses(result), ["aerolink:ok", "skymesh:error", "aerolink-b:ok"]);
  assert.equal(typeof result.suppliers[1].error, "string");
  assert.ok(result.suppliers[1].error.length > 0);
  assert.equal(result.suppliers[1].offers, 0);
  assert.deepEqual(result.itineraries, expected([["aerolink", MA], ["aerolink-b", MB]]));
});

test("s2 an unparsable payload is a supplier error", async () => {
  const bad: GenOffer[] = [
    { ...MA[0], amounts: { base: "38450.00", taxes: [{ code: "AE", amount: "1.234" }, { code: "BD", amount: "3105.00" }] } },
  ];
  const { svc } = await service([
    resolving("aerolink", "aerolink", "{not json"),
    resolving("aerolink-b", "aerolink", aeroLinkRaw(bad)),
    okSkymesh(),
  ]);
  const result = await svc.searchWithStatus(request());
  assert.deepEqual(statuses(result), ["aerolink:error", "aerolink-b:error", "skymesh:ok"]);
  assert.deepEqual(result.itineraries, expected([["skymesh", MS]]));
});

test("s2 a hanging supplier times out", async () => {
  const hanging = neverResolving("skymesh", "skymesh");
  const { svc } = await service([okAerolink(), hanging]);
  const start = performance.now();
  const result = await svc.searchWithStatus(request(), { timeoutMs: 100 });
  assert.ok(performance.now() - start < 3000, "resolved soon after the deadline");
  assert.deepEqual(statuses(result), ["aerolink:ok", "skymesh:timeout"]);
  assert.equal(result.partial, true);
  assert.equal(hanging.calls[0].signal?.aborted, true, "the timed-out call was aborted");
  assert.deepEqual(result.itineraries, expected([["aerolink", MA]]));
});

test("s2 late responses are ignored", async () => {
  await noUnhandledRejections(async () => {
    const late = deferred("skymesh", "skymesh");
    const { svc } = await service([okAerolink(), late.client]);
    const result = await svc.searchWithStatus(request(), { timeoutMs: 50 });
    assert.deepEqual(statuses(result), ["aerolink:ok", "skymesh:timeout"]);
    const snapshot = structuredClone(result);
    late.resolve(RAW.skymesh);
    await tick();
    assert.deepEqual(result, snapshot);
  });
});

test("s2 late rejections are ignored", async () => {
  await noUnhandledRejections(async () => {
    const late = deferred("skymesh", "skymesh");
    const { svc } = await service([okAerolink(), late.client]);
    const result = await svc.searchWithStatus(request(), { timeoutMs: 50 });
    const snapshot = structuredClone(result);
    late.reject(new Error("connection reset"));
    await tick();
    assert.deepEqual(result, snapshot);
  });
});

test("s2 defaultTimeoutMs from the constructor applies", async () => {
  const { svc } = await service([okAerolink(), neverResolving("skymesh", "skymesh")], { defaultTimeoutMs: 50 });
  const start = performance.now();
  const result = await svc.searchWithStatus(request());
  assert.ok(performance.now() - start < 3000);
  assert.deepEqual(statuses(result), ["aerolink:ok", "skymesh:timeout"]);
});

test("s2 every supplier failing", async () => {
  const clients = () => [rejecting("aerolink", "aerolink", new Error("HTTP 502")), neverResolving("skymesh", "skymesh")];
  const { app, svc } = await service(clients(), { defaultTimeoutMs: 50 });
  const result = await svc.searchWithStatus(request());
  assert.deepEqual(result.itineraries, []);
  assert.equal(result.partial, true);
  assert.deepEqual(statuses(result), ["aerolink:error", "skymesh:timeout"]);
  await assert.rejects(async () => svc.search(request()), app.NoSuppliersAvailableError);
  const http = await app.handleSearch(svc, request());
  assert.equal(http.status, 503);
  assert.equal(http.body.suppliers.length, 2);
});

test("s2 search() returns partial results", async () => {
  const { svc } = await service([rejecting("aerolink", "aerolink", new Error("HTTP 500")), okSkymesh()]);
  const itineraries = await svc.search(request());
  assert.ok(Array.isArray(itineraries));
  assert.deepEqual(itineraries, expected([["skymesh", MS]]));
});

test("s2 caller abort cancels everything", async () => {
  const a = neverResolving("aerolink", "aerolink");
  const b = neverResolving("skymesh", "skymesh");
  const { svc } = await service([a, b]);
  const controller = new AbortController();
  const pending = svc.searchWithStatus(request(), { timeoutMs: 30_000, signal: controller.signal });
  await tick();
  const reason = new Error("user left");
  controller.abort(reason);
  await assert.rejects(async () => pending, (err) => err === reason);
  assert.equal(a.calls[0]?.signal?.aborted, true);
  assert.equal(b.calls[0]?.signal?.aborted, true);
});

test("s2 already-aborted caller signal", async () => {
  const a = okAerolink();
  const { svc } = await service([a]);
  const reason = new Error("user left");
  await assert.rejects(async () => svc.searchWithStatus(request(), { signal: AbortSignal.abort(reason) }), (err) => err === reason);
  assert.equal(a.calls.length, 0);
});

test("s2 invalid timeoutMs", async () => {
  const a = okAerolink();
  const { app, svc } = await service([a]);
  for (const timeoutMs of [0, -1, 1.5, 30001, Number.NaN, "100"]) {
    await assert.rejects(async () => svc.searchWithStatus(request(), { timeoutMs }), app.ValidationError, String(timeoutMs));
  }
  assert.equal(a.calls.length, 0);
});

test("s2 invalid request rejected before fan-out", async () => {
  const a = okAerolink();
  const { app, svc } = await service([a]);
  const bad = { ...request(), legs: [{ origin: "DA1", destination: "DXB", date: "2026-12-01" }, ANY_REQUEST.legs[1]] };
  await assert.rejects(async () => svc.searchWithStatus(bad), app.ValidationError);
  const http = await app.handleSearch(svc, bad);
  assert.equal(http.status, 400);
  assert.equal(a.calls.length, 0);
});

test("s2 no listeners left on the caller signal", async () => {
  const signal = new AbortController().signal;
  const ok = await service([okAerolink(), okSkymesh()]);
  await ok.svc.searchWithStatus(request(), { signal });
  assert.equal(getEventListeners(signal, "abort").length, 0, "after a successful search");
  const slow = await service([okAerolink(), neverResolving("skymesh", "skymesh")]);
  await slow.svc.searchWithStatus(request(), { signal, timeoutMs: 50 });
  assert.equal(getEventListeners(signal, "abort").length, 0, "after a timeout");
  const failing = await service([rejecting("aerolink", "aerolink", new Error("down"))]);
  await failing.svc.searchWithStatus(request(), { signal });
  assert.equal(getEventListeners(signal, "abort").length, 0, "after every supplier failed");
});

test("s2 nothing keeps the process alive after a search", { timeout: 60_000 }, async () => {
  await loadApp();
  const child = await runChild(new URL("./helpers/settle-child.ts", import.meta.url), 15_000);
  assert.equal(child.killed, false, `still running after 15 s\n${child.stdout}${child.stderr}`);
  assert.equal(child.code, 0, child.stderr);
  assert.match(child.stdout, /done/);
});
