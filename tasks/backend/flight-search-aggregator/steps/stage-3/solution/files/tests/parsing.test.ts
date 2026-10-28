import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FlightSearchService } from "../src/index.ts";
import type { SearchRequest, SupplierClient, SupplierFormat } from "../src/index.ts";
import { WorkerPool } from "../src/parsing/worker-pool.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const client = (name: string, format: SupplierFormat, raw: () => string): SupplierClient => ({ name, format, search: async () => raw() });
const request: SearchRequest = {
  tripType: "return",
  legs: [
    { origin: "DAC", destination: "DXB", date: "2026-12-01" },
    { origin: "DXB", destination: "DAC", date: "2026-12-10" },
  ],
  passengers: 1,
};

test("parsing in threads gives the same results as before", async () => {
  const svc = new FlightSearchService(
    [client("aerolink", "aerolink", () => fixture("aerolink-dac-dxb.json")), client("skymesh", "skymesh", () => fixture("skymesh-dac-dxb.json"))],
    { parserThreads: 2 },
  );
  try {
    const result = await svc.searchWithStatus(request);
    assert.deepEqual(result.itineraries.map((it) => it.id), ["skymesh:SM-55102", "aerolink:AL-000124", "skymesh:SM-55103"]);
  } finally {
    await svc.close();
  }
});

test("a payload that fails in a thread is a supplier error, and the next search works", async () => {
  let raw = JSON.stringify({ currency: "BDT", offers: [{ offerId: "x" }] });
  const svc = new FlightSearchService([client("aerolink", "aerolink", () => raw)], { parserThreads: 1 });
  try {
    assert.equal((await svc.searchWithStatus(request)).suppliers[0].status, "error");
    raw = fixture("aerolink-dac-dxb.json");
    assert.equal((await svc.searchWithStatus(request)).suppliers[0].status, "ok");
  } finally {
    await svc.close();
  }
});

test("close() is idempotent and later searches reject", async () => {
  const svc = new FlightSearchService([client("aerolink", "aerolink", () => fixture("aerolink-dac-dxb.json"))], { parserThreads: 1 });
  await svc.searchWithStatus(request);
  await svc.close();
  await svc.close();
  await assert.rejects(async () => svc.searchWithStatus(request), /closed/);
});

test("closing the pool rejects queued jobs instead of hanging them", async () => {
  const pool = new WorkerPool(1);
  const jobs = [1, 2, 3].map(() => pool.parse("aerolink", fixture("aerolink-dac-dxb.json"), "aerolink"));
  const settled = Promise.allSettled(jobs);
  await pool.close();
  assert.ok((await settled).every((s) => s.status === "rejected"));
});
