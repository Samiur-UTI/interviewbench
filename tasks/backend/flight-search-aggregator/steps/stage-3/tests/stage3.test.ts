// Stage 3 hidden tests (part 1): the merge scales, results are unchanged, parse failures in a
// thread are supplier errors, and the service shuts down cleanly. The responsiveness tests are in
// stage3-responsive.test.ts (their own process, so nothing here disturbs their measurements).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadApp } from "./helpers/app.ts";
import { runChild } from "./helpers/child.ts";
import { neverResolving, resolving } from "./helpers/fakes.ts";
import type { FakeClient } from "./helpers/fakes.ts";
import { ANY_REQUEST, aeroLinkRaw, genMarket, skyMeshRaw, toItineraries } from "./helpers/payloads.ts";
import type { GenOffer } from "./helpers/payloads.ts";
import { referenceMerge, referenceSearch } from "./helpers/reference.ts";

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

const PREFERENCE = ["aerolink", "skymesh", "aerolink-b"];
const statuses = (r: { suppliers: { supplier: string; status: string }[] }) => r.suppliers.map((s) => `${s.supplier}:${s.status}`);

test("s3 merge scales", { timeout: 60_000 }, async (t) => {
  const app = await loadApp();
  // Generated outside the timed section: 150k offers over 3 suppliers, 25% repeated trips.
  const market = genMarket(301, 150_000, 3, { dupRatio: 0.25 });
  const full = market.map((offers, i) => toItineraries(offers, PREFERENCE[i]));
  let total = 0;
  let last: { id: string; totalPrice: number }[] = [];
  for (const size of [10_000, 20_000, 40_000, 80_000, 150_000]) {
    const lists = full.map((l) => l.slice(0, Math.round((l.length * size) / 150_000)));
    const start = performance.now();
    last = app.mergeItineraries(lists, PREFERENCE);
    const ms = performance.now() - start;
    total += ms;
    t.diagnostic(`merge ${size}: ${ms.toFixed(0)} ms (cumulative ${total.toFixed(0)} ms)`);
    assert.ok(ms < 2000, `merging ${size} offers took ${ms.toFixed(0)} ms (limit 2000 ms per step)`);
    assert.ok(total < 3000, `merging up to ${size} offers took ${total.toFixed(0)} ms in total (limit 3000 ms)`);
  }
  const expected = referenceMerge(full, PREFERENCE);
  assert.equal(last.length, expected.length);
  assert.deepEqual(
    last.map((it) => `${it.id}/${it.totalPrice}`),
    expected.map((it) => `${it.id}/${it.totalPrice}`),
  );
});

test("s3 merge is unchanged", async () => {
  const app = await loadApp();
  const market = genMarket(302, 2000, 3, { dupRatio: 0.4, ties: true });
  const lists = market.map((offers, i) => toItineraries(offers, PREFERENCE[i]));
  assert.deepEqual(app.mergeItineraries(lists, PREFERENCE), referenceMerge(lists, PREFERENCE));
});

test("s3 search results are unchanged", async () => {
  const [a, s, b] = genMarket(303, 9000, 3, { dupRatio: 0.3 });
  const { svc } = await service([
    resolving("aerolink", "aerolink", aeroLinkRaw(a, { bulkBytes: 600 })),
    resolving("skymesh", "skymesh", skyMeshRaw(s)),
    resolving("aerolink-b", "aerolink", aeroLinkRaw(b, { seed: 3, bulkBytes: 600 })),
  ]);
  const result = await svc.searchWithStatus({ ...ANY_REQUEST, passengers: 2 });
  assert.deepEqual(
    result.suppliers.map((x: { supplier: string; status: string; offers: number }) => [x.supplier, x.status, x.offers]),
    [
      ["aerolink", "ok", a.length],
      ["skymesh", "ok", s.length],
      ["aerolink-b", "ok", b.length],
    ],
  );
  assert.equal(result.partial, false);
  const expected = referenceSearch(
    [
      { name: "aerolink", itineraries: toItineraries(a, "aerolink") },
      { name: "skymesh", itineraries: toItineraries(s, "skymesh") },
      { name: "aerolink-b", itineraries: toItineraries(b, "aerolink-b") },
    ],
    2,
  );
  assert.deepEqual(result.itineraries, expected);
});

test("s3 bad payload in a worker is an error, service keeps working", async () => {
  const [offers, sky] = genMarket(304, 5000, 2, { dupRatio: 0 });
  const bad: GenOffer[] = offers.map((o, i) =>
    i === 2000 ? { ...o, amounts: { base: "38450.00", taxes: [{ code: "AE", amount: "4100.605" }, { code: "BD", amount: "3105.00" }] } } : o,
  );
  const badRaw = aeroLinkRaw(bad, { bulkBytes: 1000 });
  const goodRaw = aeroLinkRaw(offers, { bulkBytes: 1000 });
  let raw = badRaw;
  const { svc } = await service([resolving("aerolink", "aerolink", () => raw), resolving("skymesh", "skymesh", skyMeshRaw(sky))]);
  const first = await svc.searchWithStatus(ANY_REQUEST);
  assert.deepEqual(statuses(first), ["aerolink:error", "skymesh:ok"]);
  raw = goodRaw;
  const second = await svc.searchWithStatus(ANY_REQUEST);
  assert.deepEqual(statuses(second), ["aerolink:ok", "skymesh:ok"]);
  assert.equal(second.suppliers[0].offers, offers.length);
});

test("s3 process exits after close()", { timeout: 60_000 }, async () => {
  await loadApp();
  const child = await runChild(new URL("./helpers/close-child.ts", import.meta.url), 20_000);
  assert.equal(child.killed, false, `still running 20 s after close()\n${child.stdout}${child.stderr}`);
  assert.equal(child.code, 0, child.stderr);
  assert.match(child.stdout, /done/);
});

test("s3 search after close rejects", async () => {
  const [offers] = genMarket(305, 20, 1);
  const { svc } = await service([resolving("aerolink", "aerolink", aeroLinkRaw(offers))]);
  await svc.searchWithStatus(ANY_REQUEST);
  await svc.close();
  await assert.rejects(async () => svc.searchWithStatus(ANY_REQUEST), Error);
  await assert.rejects(async () => svc.search(ANY_REQUEST), Error);
  await svc.close();
});

test("s3 parserThreads validation", async () => {
  const app = await loadApp();
  const [offers] = genMarket(306, 50, 1);
  const client = resolving("aerolink", "aerolink", aeroLinkRaw(offers));
  for (const parserThreads of [0, -1, 1.5, "2"]) {
    assert.throws(() => new app.FlightSearchService([client], { parserThreads }), app.ValidationError, String(parserThreads));
  }
  const { svc } = await service([client], { parserThreads: 1 });
  const result = await svc.searchWithStatus(ANY_REQUEST);
  assert.deepEqual(statuses(result), ["aerolink:ok"]);
  assert.deepEqual(result.itineraries, referenceSearch([{ name: "aerolink", itineraries: toItineraries(offers, "aerolink") }], 1));
});

test("s3 stage 2 behaviour holds", async () => {
  const [offers] = genMarket(307, 30, 1);
  const hanging = neverResolving("skymesh", "skymesh");
  const { svc } = await service([resolving("aerolink", "aerolink", aeroLinkRaw(offers)), hanging]);
  const start = performance.now();
  const result = await svc.searchWithStatus(ANY_REQUEST, { timeoutMs: 100 });
  assert.ok(performance.now() - start < 3000);
  assert.deepEqual(statuses(result), ["aerolink:ok", "skymesh:timeout"]);
  assert.equal(hanging.calls[0].signal?.aborted, true);
});
