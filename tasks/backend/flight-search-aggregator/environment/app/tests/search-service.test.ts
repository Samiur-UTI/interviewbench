import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FlightSearchService, handleSearch, ValidationError } from "../src/index.ts";
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
