import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FlightSearchService, handleSearch, ValidationError } from "../src/index.ts";
import type { SearchRequest, SupplierClient, SupplierFormat } from "../src/index.ts";

// The three fixtures answer the same search: DXB -> SIN on 1 Dec, SIN -> DXB on 8 Dec, 2 adults + 1 child.
const fixture = (format: SupplierFormat): string => readFileSync(new URL(`./fixtures/${format}-dxb-sin.json`, import.meta.url), "utf8");

function fakeClient(format: SupplierFormat, respond: () => Promise<string> = async () => fixture(format)): SupplierClient & { calls: number } {
  return {
    name: format,
    format,
    calls: 0,
    search() {
      this.calls++;
      return respond();
    },
  };
}

const request = (adults = 2, children = 1): SearchRequest => ({
  tripType: "return",
  legs: [
    { origin: "DXB", destination: "SIN", date: "2026-12-01" },
    { origin: "SIN", destination: "DXB", date: "2026-12-08" },
  ],
  passengers: { adults, children },
});

const allThree = () => [fakeClient("caravel"), fakeClient("tessera"), fakeClient("keystone")];

test("a search merges every supplier's offers, cheapest first", async () => {
  const result = await new FlightSearchService(allThree()).searchWithStatus(request());
  assert.equal(result.partial, false);
  assert.deepEqual(
    result.suppliers.map((s) => `${s.supplier}:${s.status}:${s.offers}`),
    ["caravel:ok:3", "tessera:ok:3", "keystone:ok:3"],
  );
  assert.deepEqual(
    result.itineraries.map((it) => it.id),
    ["tessera:2.1", "tessera:1.1", "keystone:pP1==|oA2==|oA3=="],
  );
});

test("offers without a seat for every passenger are hidden", async () => {
  const result = await new FlightSearchService(allThree()).searchWithStatus(request(3, 2));
  assert.deepEqual(
    result.itineraries.map((it) => it.id),
    ["tessera:2.1", "keystone:pP1==|oA2==|oA3=="],
  );
});

test("a supplier that misses the deadline is reported, the others are still shown", async () => {
  const hanging = fakeClient("keystone", () => new Promise<string>(() => {}));
  const service = new FlightSearchService([fakeClient("caravel"), fakeClient("tessera"), hanging]);
  const result = await service.searchWithStatus(request(), { timeoutMs: 50 });
  assert.equal(result.partial, true);
  assert.deepEqual(
    result.suppliers.map((s) => `${s.supplier}:${s.status}`),
    ["caravel:ok", "tessera:ok", "keystone:timeout"],
  );
  assert.deepEqual(
    result.itineraries.map((it) => it.id),
    ["tessera:2.1", "tessera:1.1"],
  );
});

test("a supplier error doesn't sink the others", async () => {
  const broken = fakeClient("tessera", async () => "<html>502 Bad Gateway</html>");
  const result = await new FlightSearchService([fakeClient("caravel"), broken, fakeClient("keystone")]).searchWithStatus(request());
  assert.equal(result.suppliers[1].status, "error");
  assert.deepEqual(
    result.itineraries.map((it) => it.id),
    ["caravel:3", "caravel:1", "keystone:pP1==|oA2==|oA3=="],
  );
});

test("invalid requests are rejected before asking suppliers", async () => {
  const clients = allThree();
  const service = new FlightSearchService(clients);
  await assert.rejects(async () => service.searchWithStatus({ ...request(), passengers: { adults: 0, children: 1 } }), ValidationError);
  await assert.rejects(async () => service.searchWithStatus(request(), { timeoutMs: 0 }), ValidationError);
  assert.deepEqual(clients.map((c) => c.calls), [0, 0, 0]);
});

test("the HTTP handler maps results, validation errors and unavailable suppliers", async () => {
  const ok = await handleSearch(new FlightSearchService(allThree()), request());
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { itineraries: unknown[] }).itineraries.length, 3);
  const bad = await handleSearch(new FlightSearchService(allThree()), { tripType: "oneway", legs: [], passengers: { adults: 1, children: 0 } });
  assert.equal(bad.status, 400);
  const down = [fakeClient("caravel", async () => Promise.reject(new Error("HTTP 503")))];
  assert.equal((await handleSearch(new FlightSearchService(down), request())).status, 503);
});
