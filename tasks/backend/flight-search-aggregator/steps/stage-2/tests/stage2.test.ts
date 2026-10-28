// Stage 2 hidden tests: searches are persisted before they are answered, and paged from the
// database in the order the user picked, with stable keyset cursors.
//
// Data is small (at most 3 x 150 offers per search) so a straightforward implementation that
// commits row by row stays fast at synchronous=FULL. Every test uses a fresh database file and
// reads it through its own read-only connection.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { loadApp } from "./helpers/app.ts";
import type { App } from "./helpers/app.ts";
import { neverResolving, rejecting, resolving } from "./helpers/fakes.ts";
import type { FakeClient } from "./helpers/fakes.ts";
import { generateSearch, tripKey } from "./helpers/payloads.ts";
import type { ExpectedItinerary, GeneratedSearch, SearchOptions, SortPreference } from "./helpers/payloads.ts";
import { compareKeys, referenceOffers, referenceOrder, referenceRows, SORTS, sortKeys, TABLE_QUERIES } from "./helpers/reference.ts";
import type { ReferenceRows, SupplierOutcome } from "./helpers/reference.ts";

type It = ExpectedItinerary;

const dirs: string[] = [];
const connections: DatabaseSync[] = [];
after(() => {
  for (const c of connections) if (c.isOpen) c.close();
  // Best effort: the services under test may still hold their database open (Windows refuses).
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ib-s2-"));
  dirs.push(dir);
  return join(dir, "search.db");
}

/** The test's own connection: read-only, so it sees exactly what has been committed. */
function testConnection(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  connections.push(db);
  return db;
}

// 150 Caravel offers, 150 Tessera quotes, ~150 Keystone offers. "dense" snaps prices and times
// so every sort order has many ties; XB is weighted so preferred_airline has a real split.
const DATA: SearchOptions = {
  seed: 202,
  offersPerSupplier: 150,
  tieDensity: "dense",
  carriers: ["XB", "XB", "ZK", "QV", "MR", "TJ", "WL"],
  preferredCarrier: "XB",
};
const generated = new Map<string, GeneratedSearch>();
function data(opts: SearchOptions = DATA): GeneratedSearch {
  const key = JSON.stringify(opts);
  if (!generated.has(key)) generated.set(key, generateSearch(opts));
  return generated.get(key)!;
}

const clientsOf = (g: GeneratedSearch): FakeClient[] => g.suppliers.map((s) => resolving(s.name, s.format, s.raw));
const okOutcomes = (g: GeneratedSearch): SupplierOutcome[] =>
  g.suppliers.map((s) => ({ supplier: s.name, status: "ok", offerCount: s.itineraries.length }));

async function service(clients: FakeClient[], dbPath = freshDbPath()): Promise<{ app: App; svc: any; dbPath: string }> {
  const app = await loadApp();
  return { app, svc: new app.FlightSearchService(clients, { dbPath }), dbPath };
}

function readRows(db: DatabaseSync, searchId: string): ReferenceRows {
  const rows = {} as ReferenceRows;
  for (const [table, sql] of Object.entries(TABLE_QUERIES) as [keyof ReferenceRows, string][]) {
    rows[table] = db.prepare(sql).all(searchId).map((r) => ({ ...r }));
  }
  return rows;
}

/** Every page of a search, following nextCursor. */
async function walk(svc: any, searchId: string, sort: SortPreference, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 10_000, "paging doesn't end");
    const page = await svc.getPage(searchId, { sort, limit, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(page.offers.length <= limit, `a page has ${page.offers.length} offers, limit ${limit}`);
    ids.push(...page.offers.map((o: It) => o.id));
    if (page.nextCursor === null) {
      return ids;
    }
    assert.equal(typeof page.nextCursor, "string");
    assert.ok(page.offers.length > 0, "an empty page with a nextCursor");
    cursor = page.nextCursor;
  }
}

const cursorOf = (json: unknown): string => Buffer.from(JSON.stringify(json)).toString("base64url");

test("s2 everything is committed before the search resolves", async () => {
  const g = data();
  const { svc, dbPath } = await service(clientsOf(g));
  const result = await svc.searchWithStatus(g.request);
  // Nothing else may run between the answer and this read.
  const stored = readRows(testConnection(dbPath), result.searchId);
  const expected = referenceRows(result.searchId, g.request, okOutcomes(g), referenceOffers(g.suppliers, g.request.passengers));
  assert.deepEqual(stored.searches, expected.searches);
  assert.deepEqual(stored.supplier_results, expected.supplier_results);
  assert.equal(stored.offers.length, expected.offers.length, "number of stored offers");
  assert.deepEqual(stored.offers, expected.offers);
  assert.deepEqual(stored.offer_segments, expected.offer_segments);
  assert.deepEqual(stored.offer_prices, expected.offer_prices);
});

test("s2 first page follows the requested sort", async () => {
  const g = data();
  const { svc } = await service(clientsOf(g));
  const result = await svc.searchWithStatus({ ...g.request, sort: "fastest" }, { limit: 10 });
  const offers = referenceOffers(g.suppliers, g.request.passengers);
  assert.equal(result.total, offers.length);
  assert.equal(result.partial, false);
  assert.match(result.searchId, /\S/);
  assert.deepEqual(
    result.page.offers.map((o: It) => o.id),
    referenceOrder(offers, "fastest").slice(0, 10).map((o) => o.id),
  );
  assert.equal(typeof result.page.nextCursor, "string");
});

for (const sort of SORTS) {
  test(`s2 ${sort} pages walk all offers in order`, async () => {
    const g = data();
    const { svc } = await service(clientsOf(g));
    const { searchId } = await svc.searchWithStatus(g.request);
    const ids = await walk(svc, searchId, sort, 7);
    assert.equal(new Set(ids).size, ids.length, "an offer was shown twice");
    const expected = referenceOrder(referenceOffers(g.suppliers, g.request.passengers), sort, g.request.preferredCarrier);
    assert.deepEqual(ids, expected.map((o) => o.id));
  });
}

test("s2 offers read back match what was parsed", async () => {
  const g = data();
  const { svc } = await service(clientsOf(g));
  const { searchId } = await svc.searchWithStatus(g.request);
  const byId = new Map(referenceOffers(g.suppliers, g.request.passengers).map((it) => [it.id, it]));
  const page = await svc.getPage(searchId, { sort: "cheapest", limit: 50 });
  assert.equal(page.offers.length, 50);
  for (const offer of page.offers) assert.deepEqual(offer, byId.get(offer.id));
});

test("s2 pages are stable while other searches are written", async () => {
  const g = data();
  const { svc } = await service(clientsOf(g));
  const { searchId } = await svc.searchWithStatus(g.request);
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await svc.getPage(searchId, { sort: "cheapest", limit: 5, ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...page.offers.map((o: It) => o.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    if (ids.length % 25 === 0) await svc.searchWithStatus(g.request); // the same trips, a new search
  }
  const expected = referenceOrder(referenceOffers(g.suppliers, g.request.passengers), "cheapest");
  assert.deepEqual(ids, expected.map((o) => o.id));
});

test("s2 pages come from the database", async () => {
  const g = data();
  const { app, svc, dbPath } = await service(clientsOf(g));
  const { searchId } = await svc.searchWithStatus(g.request);
  const first = await walk(svc, searchId, "fewest_stops", 20);
  const other = new app.FlightSearchService(clientsOf(g), { dbPath });
  assert.deepEqual(await walk(other, searchId, "fewest_stops", 20), first);
  const page = await other.getPage(searchId, { sort: "cheapest", limit: 3 });
  const expected = referenceOrder(referenceOffers(g.suppliers, g.request.passengers), "cheapest").slice(0, 3);
  assert.deepEqual(page.offers, expected);
});

test("s2 cursor format", async () => {
  const g = data();
  const { svc } = await service(clientsOf(g));
  const { searchId } = await svc.searchWithStatus(g.request);
  for (const sort of SORTS) {
    const page = await svc.getPage(searchId, { sort, limit: 9 });
    const last = page.offers[page.offers.length - 1] as It;
    assert.match(page.nextCursor, /^[A-Za-z0-9_-]+$/, "base64url without padding");
    assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8")), {
      v: 1,
      s: searchId,
      o: sort,
      k: sortKeys(last, sort, g.request.preferredCarrier),
    });
  }
});

test("s2 a well-formed cursor is a position", async () => {
  const g = data();
  const { svc } = await service(clientsOf(g));
  const { searchId } = await svc.searchWithStatus(g.request);
  const offers = referenceOrder(referenceOffers(g.suppliers, g.request.passengers), "fastest");
  const k = 37;
  const [d, t, id] = sortKeys(offers[k], "fastest");
  const positions: [number, number, string][] = [
    [d, t, id], // an offer that exists
    [d, t, ""], // before every offer with these keys
    [d, t + 1, "~"], // between offers, naming no offer
  ];
  for (const k3 of positions) {
    const page = await svc.getPage(searchId, { sort: "fastest", limit: 6, cursor: cursorOf({ v: 1, s: searchId, o: "fastest", k: k3 }) });
    const expected = offers.filter((o) => compareKeys(sortKeys(o, "fastest"), k3) > 0).slice(0, 6);
    assert.deepEqual(page.offers.map((o: It) => o.id), expected.map((o) => o.id), `after ${JSON.stringify(k3)}`);
  }
});

test("s2 invalid cursors and limits", async () => {
  const g = data();
  const { app, svc } = await service(clientsOf(g));
  const { searchId } = await svc.searchWithStatus(g.request);
  const other = (await svc.searchWithStatus(g.request)).searchId;
  const good = (await svc.getPage(searchId, { sort: "cheapest", limit: 5 })).nextCursor as string;
  const keys = JSON.parse(Buffer.from(good, "base64url").toString("utf8")).k;
  const badCursors: unknown[] = [
    "not a cursor!",
    "eyJ2IjoxfQ", // {"v":1}
    cursorOf({ hello: "world" }),
    cursorOf({ v: 2, s: searchId, o: "cheapest", k: keys }),
    cursorOf({ v: 1, s: searchId, o: "cheapest", k: [keys[0], keys[1]] }),
    cursorOf({ v: 1, s: searchId, o: "cheapest", k: [String(keys[0]), keys[1], keys[2]] }),
    cursorOf({ v: 1, s: other, o: "cheapest", k: keys }), // another search
    cursorOf({ v: 1, s: searchId, o: "fastest", k: keys }), // another sort
    good + "=",
    42,
  ];
  for (const cursor of badCursors) {
    await assert.rejects(async () => svc.getPage(searchId, { sort: "cheapest", cursor }), app.ValidationError, `cursor ${String(cursor)}`);
  }
  for (const limit of [0, 201, 1.5, "5", -1]) {
    await assert.rejects(async () => svc.getPage(searchId, { limit }), app.ValidationError, `getPage limit ${String(limit)}`);
    await assert.rejects(async () => svc.searchWithStatus(g.request, { limit }), app.ValidationError, `search limit ${String(limit)}`);
  }
  await assert.rejects(async () => svc.getPage(searchId, { sort: "random" }), app.ValidationError);
  await assert.rejects(async () => svc.getPage("no-such-search", {}), app.SearchNotFoundError);

  const { preferredCarrier: _, ...noCarrier } = g.request;
  const plain = await svc.searchWithStatus(noCarrier);
  await assert.rejects(async () => svc.getPage(plain.searchId, { sort: "preferred_airline" }), app.ValidationError);
  await assert.rejects(async () => svc.searchWithStatus({ ...noCarrier, sort: "preferred_airline" }), app.ValidationError);
});

test("s2 duplicates stored once", async () => {
  const g = data();
  const { svc, dbPath } = await service(clientsOf(g));
  const { searchId, total } = await svc.searchWithStatus(g.request);
  const offers = referenceOffers(g.suppliers, g.request.passengers);
  // The data must really overlap, or this test proves nothing.
  const seats = g.request.passengers.adults + g.request.passengers.children;
  const copies = new Map<string, number>();
  for (const s of g.suppliers) for (const it of s.itineraries) if (it.seatsAvailable >= seats) copies.set(tripKey(it), (copies.get(tripKey(it)) ?? 0) + 1);
  assert.ok([...copies.values()].filter((n) => n > 1).length >= 20, "the dataset has fewer than 20 shared trips");

  const db = testConnection(dbPath);
  const rows = db.prepare("SELECT trip_key, offer_id FROM offers WHERE search_id = ?").all(searchId) as { trip_key: string; offer_id: string }[];
  assert.equal(total, offers.length);
  assert.equal(rows.length, offers.length);
  const winner = new Map(offers.map((it) => [tripKey(it), it.id]));
  for (const r of rows) assert.equal(r.offer_id, winner.get(r.trip_key), `trip ${r.trip_key}`);
});

test("s2 partial results are persisted", async () => {
  const g = data();
  const [caravel, tessera, keystone] = g.suppliers;
  const clients = [resolving(caravel.name, caravel.format, caravel.raw), resolving(tessera.name, tessera.format, tessera.raw), neverResolving(keystone.name, keystone.format)];
  const { svc, dbPath } = await service(clients);
  const result = await svc.searchWithStatus(g.request, { timeoutMs: 100 });
  assert.equal(result.partial, true);
  const stored = readRows(testConnection(dbPath), result.searchId);
  const outcomes: SupplierOutcome[] = [
    { supplier: caravel.name, status: "ok", offerCount: caravel.itineraries.length },
    { supplier: tessera.name, status: "ok", offerCount: tessera.itineraries.length },
    { supplier: keystone.name, status: "timeout", offerCount: 0 },
  ];
  const expected = referenceRows(result.searchId, g.request, outcomes, referenceOffers([caravel, tessera], g.request.passengers));
  assert.deepEqual(stored.supplier_results, expected.supplier_results);
  assert.deepEqual(stored.offers, expected.offers);
  assert.equal(result.total, expected.offers.length);
});

test("s2 all suppliers failing", async () => {
  const g = data();
  const failing = () => g.suppliers.map((s) => rejecting(s.name, s.format, new Error("HTTP 502")));
  const { app, svc, dbPath } = await service(failing());
  const result = await svc.searchWithStatus(g.request);
  assert.equal(result.total, 0);
  assert.deepEqual(result.page, { offers: [], nextCursor: null });
  const db = testConnection(dbPath);
  assert.deepEqual({ ...db.prepare("SELECT status FROM searches WHERE search_id = ?").get(result.searchId) }, { status: "failed" });
  assert.deepEqual({ ...db.prepare("SELECT count(*) AS n FROM offers WHERE search_id = ?").get(result.searchId) }, { n: 0 });
  assert.deepEqual(
    db.prepare("SELECT supplier, status FROM supplier_results WHERE search_id = ? ORDER BY supplier").all(result.searchId).map((r) => ({ ...r })),
    g.suppliers.map((s) => ({ supplier: s.name, status: "error" })).sort((a, b) => (a.supplier < b.supplier ? -1 : 1)),
  );
  assert.deepEqual(await svc.getPage(result.searchId, {}), { offers: [], nextCursor: null });
  const response = await app.handleSearch(svc, g.request);
  assert.equal(response.status, 503);
});

test("s2 HTTP page handler", async () => {
  const g = data();
  const { app, svc } = await service(clientsOf(g));
  const { searchId } = await svc.searchWithStatus(g.request);
  const ok = await app.handleGetPage(svc, { searchId, sort: "fastest", limit: 4 });
  assert.equal(ok.status, 200);
  const expected = referenceOrder(referenceOffers(g.suppliers, g.request.passengers), "fastest").slice(0, 4);
  assert.deepEqual(ok.body.offers.map((o: It) => o.id), expected.map((o) => o.id));
  assert.equal(typeof ok.body.nextCursor, "string");
  const next = await app.handleGetPage(svc, { searchId, sort: "fastest", limit: 4, cursor: ok.body.nextCursor });
  assert.equal(next.status, 200);
  assert.equal(next.body.offers[0].id, referenceOrder(referenceOffers(g.suppliers, g.request.passengers), "fastest")[4].id);
  assert.equal((await app.handleGetPage(svc, { searchId, limit: 0 })).status, 400);
  assert.equal((await app.handleGetPage(svc, { searchId, cursor: "garbage" })).status, 400);
  assert.equal((await app.handleGetPage(svc, { searchId: "no-such-search" })).status, 404);
  const search = await app.handleSearch(svc, g.request);
  assert.equal(search.status, 200);
  assert.deepEqual(Object.keys(search.body).sort(), ["page", "partial", "searchId", "suppliers", "total"]);
});
