// Stage 3 hidden tests (part 1): structurally efficient persistence and paging, durability kept,
// the 1 s processing budget, unchanged results, clean shutdown. The responsiveness tests are in
// stage3-responsive.test.ts.
//
// The structural tests run helpers/scenario.ts in a child process under the test-owned SQLite
// spy (helpers/db-spy.mjs), which counts what the code under test does with node:sqlite in every
// thread: write statements outside a transaction, commits, statement compiles, rows and bytes
// read, and the SQL of every read (for EXPLAIN QUERY PLAN). The checks themselves are in
// helpers/db-checks.ts; tests/helpers/spy-selftest.ts shows each known bypass being caught.
//
// Host measurements (Windows 11, 16 cores, Node 24.13.1), 5 runs:
// - stage-3 reference: 12/12 every run. Per search: 0 autocommit writes, 1 commit, 1 WAL commit,
//   2 compiles. Page 3 of 50: ~250-350 rows, ~30-50 KB. Budget: R 342-349 ms, best run 360-394 ms
//   (bound 1000 ms).
// - stage-2 reference: fails tests 1-4, the budget (killed at 55 s), close and parserThreads.
// Docker (--cpus=2 / --cpus=1): not yet measured; the Docker daemon was unavailable.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadApp } from "./helpers/app.ts";
import { runChild, runScenario, SPY_FLAGS } from "./helpers/child.ts";
import { resolving } from "./helpers/fakes.ts";
import type { FakeClient } from "./helpers/fakes.ts";
import { generateSearch } from "./helpers/payloads.ts";
import type { ExpectedItinerary, GeneratedSearch } from "./helpers/payloads.ts";
import { referenceOffers, referenceOrder, referenceRows, SORTS, TABLE_QUERIES } from "./helpers/reference.ts";
import type { ReferenceRows } from "./helpers/reference.ts";

const SCENARIO = new URL("./helpers/scenario.ts", import.meta.url);
const CHILD_TIMEOUT = { timeout: 60_000 };
const CHILD_LIMIT_MS = 55_000;

const services: { close?: () => Promise<void> }[] = [];
after(async () => {
  for (const s of services) if (typeof s.close === "function") await s.close();
});

const freshDbPath = (): string => join(mkdtempSync(join(tmpdir(), "ib-s3-")), "search.db");

function scenario<T>(name: string, args: object, spy = true): Promise<T> {
  return runScenario<T>(SCENARIO, {
    args: [name, JSON.stringify(args)],
    execArgv: spy ? SPY_FLAGS : [],
    limitMs: CHILD_LIMIT_MS,
  });
}

interface MeasuredSearch {
  offers: number;
  stats: { prepares: number; autocommitWrites: number; commits: number; changes: number };
  walCommits: number | null;
  rowsInDb: number;
  problems: string[];
}
interface SearchesResult {
  searches: Record<string, MeasuredSearch[]>;
  prepareProblems: string[];
}

// Tests 1 and 2 share one run of the "searches" scenario (two searches at each size).
let searches: Promise<SearchesResult> | undefined;
const searchesAt300And3000 = () => (searches ??= scenario<SearchesResult>("searches", { sizes: [300, 3000] }));

const describe = (s: MeasuredSearch) =>
  `${s.offers} offers: ${s.stats.autocommitWrites} autocommit writes, ${s.stats.commits} commits, ` +
  `${s.walCommits ?? "?"} WAL commits, ${s.stats.prepares} compiles, ${s.rowsInDb} rows, ${s.stats.changes} changes seen`;

test("s3 writes are batched", CHILD_TIMEOUT, async (t) => {
  const result = await searchesAt300And3000();
  const problems: string[] = [];
  for (const [size, runs] of Object.entries(result.searches)) {
    runs.forEach((s, i) => {
      t.diagnostic(`3x${size} search ${i + 1}: ${describe(s)}`);
      problems.push(...s.problems.filter((p) => !/synchronous|journal_mode|connection to/.test(p)).map((p) => `3x${size}: ${p}`));
    });
  }
  assert.deepEqual(problems, []);
});

test("s3 statements are reused", CHILD_TIMEOUT, async () => {
  const result = await searchesAt300And3000();
  assert.deepEqual(result.prepareProblems, []);
});

interface PagesResult {
  total: number;
  k: number;
  calls: { sort: string; pageNo: number; offers: number; rowsRead: number; bytesRead: number; planProblems: string[]; readProblems: string[] }[];
}
let pages: Promise<PagesResult> | undefined;
const pagesOf9k = () => (pages ??= scenario<PagesResult>("pages", { size: 3000, limit: 50 }));

test("s3 every sort is served by an index", CHILD_TIMEOUT, async () => {
  const result = await pagesOf9k();
  const problems = result.calls
    .filter((c) => c.pageNo !== 2)
    .flatMap((c) => c.planProblems.map((p) => `${c.sort} page ${c.pageNo}: ${p}`));
  assert.deepEqual(problems, []);
});

test("s3 pages read only what they show", CHILD_TIMEOUT, async (t) => {
  const result = await pagesOf9k();
  t.diagnostic(`${result.total} offers stored, up to ${result.k} rows per offer`);
  for (const c of result.calls) t.diagnostic(`${c.sort} page ${c.pageNo}: ${c.offers} offers, ${c.rowsRead} rows, ${c.bytesRead} bytes read`);
  assert.ok(result.calls.every((c) => c.offers === 50), "every page should be full");
  assert.deepEqual(result.calls.flatMap((c) => c.readProblems.map((p) => `${c.sort} page ${c.pageNo}: ${p}`)), []);
});

test("s3 durability settings unchanged", CHILD_TIMEOUT, async () => {
  const result = await scenario<SearchesResult>("searches", { sizes: [300] });
  const problems = result.searches[300].flatMap((s) => s.problems.filter((p) => /synchronous|journal_mode|connection to|eval/.test(p)));
  assert.deepEqual(problems, []);
});

test("s3 first page within 1 s of the last supplier answer", CHILD_TIMEOUT, async (t) => {
  const r = await scenario<{ R: number; runs: number[]; bound: number }>("budget", { size: 5000 }, false);
  const best = Math.min(...r.runs);
  t.diagnostic(`R ${r.R.toFixed(0)} ms, runs ${r.runs.map((x) => x.toFixed(0)).join(" / ")} ms, bound ${r.bound.toFixed(0)} ms`);
  assert.ok(best <= r.bound, `the first page was ready ${best.toFixed(0)} ms after the last supplier answered (limit ${r.bound.toFixed(0)} ms)`);
});

// ---- in this process --------------------------------------------------------------------------

async function service(clients: FakeClient[], options: object = {}) {
  const app = await loadApp();
  const dbPath = freshDbPath();
  const svc = new app.FlightSearchService(clients, { dbPath, ...options });
  services.push(svc);
  return { app, svc, dbPath };
}
const clientsOf = (g: GeneratedSearch): FakeClient[] => g.suppliers.map((s) => resolving(s.name, s.format, s.raw));

test("s3 results unchanged", async () => {
  const g = generateSearch({ seed: 307, offersPerSupplier: 500, tieDensity: "dense", carriers: ["XB", "XB", "ZK", "QV", "MR"], preferredCarrier: "XB" });
  const { svc, dbPath } = await service(clientsOf(g));
  const result = await svc.searchWithStatus(g.request);
  const offers = referenceOffers(g.suppliers, g.request.passengers);
  assert.equal(result.total, offers.length);
  for (const sort of SORTS) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.getPage(result.searchId, { sort, limit: 37, ...(cursor === undefined ? {} : { cursor }) });
      ids.push(...page.offers.map((o: ExpectedItinerary) => o.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.deepEqual(ids, referenceOrder(offers, sort, g.request.preferredCarrier).map((o) => o.id), `${sort} order`);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const outcomes = g.suppliers.map((s) => ({ supplier: s.name, status: "ok" as const, offerCount: s.itineraries.length }));
    const expected = referenceRows(result.searchId, g.request, outcomes, offers);
    for (const [table, sql] of Object.entries(TABLE_QUERIES) as [keyof ReferenceRows, string][]) {
      assert.deepEqual(db.prepare(sql).all(result.searchId).map((r) => ({ ...r })), expected[table], `${table} rows`);
    }
  } finally {
    db.close();
  }
});

test("s3 close releases everything", CHILD_TIMEOUT, async () => {
  const r = await runChild(SCENARIO, { args: ["close", JSON.stringify({ size: 1000 })], limitMs: 20_000 });
  assert.equal(r.killed, false, "the process didn't exit by itself within 20 s of close(): something is still running");
  assert.equal(r.code, 0, r.stderr.slice(-2000));
  const line = r.stdout.split("\n").find((l) => l.startsWith("SCENARIO-RESULT "));
  assert.ok(line, "no result printed");
  assert.deepEqual(JSON.parse(line.slice("SCENARIO-RESULT ".length)), { searchRejects: true, getPageRejects: true });
});

test("s3 bad payload is an error, service keeps working", async () => {
  const g = generateSearch({ seed: 309, offersPerSupplier: 100 });
  const [caravel, tessera, keystone] = g.suppliers;
  // Valid JSON, but one leg reference deep inside points at a schedule leg that doesn't exist.
  const broken = JSON.parse(tessera.raw);
  const legRefs = broken.shopResponse.groups[0].itineraries[0].legs;
  legRefs[legRefs.length - 1].ref = 987654;
  let tesseraRaw = JSON.stringify(broken);
  const clients = [
    resolving(caravel.name, caravel.format, caravel.raw),
    resolving(tessera.name, tessera.format, () => tesseraRaw),
    resolving(keystone.name, keystone.format, keystone.raw),
  ];
  const { svc } = await service(clients, { parserThreads: 1 });
  const first = await svc.searchWithStatus(g.request);
  assert.deepEqual(
    first.suppliers.map((s: { supplier: string; status: string }) => `${s.supplier}:${s.status}`),
    ["caravel:ok", "tessera:error", "keystone:ok"],
  );
  assert.equal(first.total, referenceOffers([caravel, keystone], g.request.passengers).length);
  tesseraRaw = tessera.raw;
  const second = await svc.searchWithStatus(g.request);
  assert.equal(second.partial, false);
  assert.equal(second.total, referenceOffers(g.suppliers, g.request.passengers).length);
});

test("s3 parserThreads validation", async () => {
  const app = await loadApp();
  const g = generateSearch({ seed: 310, offersPerSupplier: 10 });
  for (const parserThreads of [0, -1, 1.5, "2"]) {
    assert.throws(
      () => new app.FlightSearchService(clientsOf(g), { dbPath: freshDbPath(), parserThreads }),
      app.ValidationError,
      `parserThreads ${String(parserThreads)}`,
    );
  }
  const svc = new app.FlightSearchService(clientsOf(g), { dbPath: freshDbPath(), parserThreads: 3 });
  services.push(svc);
  assert.equal((await svc.searchWithStatus(g.request)).partial, false);
});
