import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FlightSearchService, handleGetPage, handleSearch, SearchNotFoundError, ValidationError } from "../src/index.ts";
import type { Itinerary, SearchRequest, SupplierClient, SupplierFormat } from "../src/index.ts";

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
const dbPath = () => join(mkdtempSync(join(tmpdir(), "flight-search-")), "search.db");
const service = (clients: SupplierClient[] = allThree(), path = dbPath()) => new FlightSearchService(clients, { dbPath: path });
const ids = (offers: Itinerary[]) => offers.map((it) => it.id);
const MERGED = ["tessera:2.1", "tessera:1.1", "keystone:pP1==|oA2==|oA3=="]; // cheapest first

test("a search is stored and its first page returned, cheapest first", async () => {
  const result = await service().searchWithStatus(request());
  assert.equal(result.partial, false);
  assert.equal(result.total, 3);
  assert.deepEqual(ids(result.page.offers), MERGED);
  assert.equal(result.page.nextCursor, null);
});

test("rows are committed before the search resolves", async () => {
  const path = dbPath();
  const result = await service(allThree(), path).searchWithStatus({ ...request(), preferredCarrier: "XB" });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const search = db.prepare("SELECT status, preferred_carrier FROM searches WHERE search_id = ?").get(result.searchId);
    assert.deepEqual({ ...search }, { status: "complete", preferred_carrier: "XB" });
    const offers = db.prepare("SELECT offer_id FROM offers WHERE search_id = ? ORDER BY offer_id").all(result.searchId);
    assert.deepEqual(offers.map((r) => r.offer_id), [...MERGED].sort());
  } finally {
    db.close();
  }
});

test("pages walk every offer once, and are read back exactly as parsed", async () => {
  const svc = service();
  const { searchId, page } = await svc.searchWithStatus(request(), { limit: 1 });
  const seen = [...page.offers];
  let cursor = page.nextCursor;
  while (cursor !== null) {
    const next = await svc.getPage(searchId, { cursor, limit: 1 });
    seen.push(...next.offers);
    cursor = next.nextCursor;
  }
  assert.deepEqual(ids(seen), MERGED);
  const fresh = await service(allThree()).searchWithStatus(request());
  assert.deepEqual(seen, fresh.page.offers);
});

test("a new service on the same database serves the pages", async () => {
  const path = dbPath();
  const { searchId } = await service(allThree(), path).searchWithStatus(request());
  const page = await service(allThree(), path).getPage(searchId, { sort: "fastest" });
  assert.equal(page.offers.length, 3);
});

test("cursors are checked against their search and sort", async () => {
  const svc = service();
  const { searchId, page } = await svc.searchWithStatus(request(), { limit: 2 });
  const other = await svc.searchWithStatus(request());
  const cursor = page.nextCursor as string;
  await assert.rejects(async () => svc.getPage(other.searchId, { cursor }), ValidationError);
  await assert.rejects(async () => svc.getPage(searchId, { cursor, sort: "fastest" }), ValidationError);
  await assert.rejects(async () => svc.getPage(searchId, { cursor: `${cursor}A` }), ValidationError);
  await assert.rejects(async () => svc.getPage(searchId, { limit: 201 }), ValidationError);
  await assert.rejects(async () => svc.getPage("missing", {}), SearchNotFoundError);
  await assert.rejects(async () => svc.getPage(searchId, { sort: "preferred_airline" }), ValidationError);
});

test("preferred_airline puts the plating carrier first without hiding the others", async () => {
  const svc = service();
  const { searchId } = await svc.searchWithStatus({ ...request(), preferredCarrier: "ZK", sort: "preferred_airline" });
  const page = await svc.getPage(searchId, { sort: "preferred_airline" });
  assert.equal(page.offers.length, 3);
  const firstOther = page.offers.findIndex((it) => it.validatingCarrier !== "ZK");
  assert.ok(page.offers.slice(firstOther).every((it) => it.validatingCarrier !== "ZK"));
});

test("when every supplier fails the search is stored as failed, with an empty page", async () => {
  const down = () => [fakeClient("caravel", async () => Promise.reject(new Error("HTTP 503")))];
  const svc = service(down());
  const result = await svc.searchWithStatus(request());
  assert.equal(result.total, 0);
  assert.deepEqual(await svc.getPage(result.searchId, {}), { offers: [], nextCursor: null });
  assert.equal((await handleSearch(service(down()), request())).status, 503);
});

test("a supplier that misses the deadline is stored as a timeout", async () => {
  const hanging = fakeClient("keystone", () => new Promise<string>(() => {}));
  const result = await service([fakeClient("caravel"), fakeClient("tessera"), hanging]).searchWithStatus(request(), { timeoutMs: 50 });
  assert.deepEqual(
    result.suppliers.map((s) => `${s.supplier}:${s.status}`),
    ["caravel:ok", "tessera:ok", "keystone:timeout"],
  );
  assert.deepEqual(ids(result.page.offers), ["tessera:2.1", "tessera:1.1"]);
});

test("the HTTP handlers map results and errors", async () => {
  const svc = service();
  const ok = await handleSearch(svc, request());
  assert.equal(ok.status, 200);
  const { searchId } = ok.body as { searchId: string };
  assert.equal((await handleSearch(svc, { tripType: "oneway", legs: [], passengers: { adults: 1, children: 0 } })).status, 400);
  assert.equal((await handleGetPage(svc, { searchId, sort: "fewest_stops" })).status, 200);
  assert.equal((await handleGetPage(svc, { searchId, limit: 0 })).status, 400);
  assert.equal((await handleGetPage(svc, { searchId: "missing" })).status, 404);
});
