// Stage-3 scenarios, each run in its own child process by stage3.test.ts:
//
//   node [--import helpers/db-spy.mjs] helpers/scenario.ts <name> <json-args>
//
// A scenario prints one result line (printResult) and exits. The structural ones run under the
// SQLite spy and apply the checks in db-checks.ts here, next to what the spy recorded, so the
// parent only reads the problems. A broken scenario fails its own test, not the whole file.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadApp } from "./app.ts";
import { printResult } from "./child.ts";
import { batchingProblems, durabilityProblems, pagePlanProblems, pageReadProblems, prepareProblems } from "./db-checks.ts";
import type { SpyStats } from "./db-checks.ts";
import { resolving } from "./fakes.ts";
import type { FakeClient } from "./fakes.ts";
import { generateSearch } from "./payloads.ts";
import type { GeneratedSearch, SearchOptions } from "./payloads.ts";
import { referenceOffers, SORTS } from "./reference.ts";
import { commitsBetween, readWal } from "./wal.ts";

interface Spy {
  mark(): Promise<void>;
  collect(): Promise<SpyStats>;
  open(path: string, options?: object): DatabaseSync;
  query(db: DatabaseSync, sql: string, ...params: unknown[]): Record<string, unknown>[];
}

const [name, argsJson = "{}"] = process.argv.slice(2);
const args = JSON.parse(argsJson);
const app = await loadApp();

const freshDbPath = (): string => join(mkdtempSync(join(tmpdir(), "ib-s3-")), "search.db");
const clientsOf = (g: GeneratedSearch): FakeClient[] => g.suppliers.map((s) => resolving(s.name, s.format, s.raw));
const dataset = (offersPerSupplier: number, extra: Partial<SearchOptions> = {}): GeneratedSearch =>
  generateSearch({ seed: 303, offersPerSupplier, carriers: ["XB", "XB", "ZK", "QV", "MR", "TJ", "WL"], preferredCarrier: "XB", ...extra });

function spy(): Spy {
  const s = (globalThis as { __ibDbSpy?: Spy }).__ibDbSpy;
  if (!s) throw new Error("this scenario needs --import helpers/db-spy.mjs");
  return s;
}

const ROW_COUNT = `SELECT (SELECT count(*) FROM searches WHERE search_id = ?1)
  + (SELECT count(*) FROM supplier_results WHERE search_id = ?1)
  + (SELECT count(*) FROM offers WHERE search_id = ?1)
  + (SELECT count(*) FROM offer_segments WHERE search_id = ?1)
  + (SELECT count(*) FROM offer_prices WHERE search_id = ?1) AS n`;

interface MeasuredSearch {
  offers: number;
  stats: Omit<SpyStats, "reads">;
  walCommits: number | null;
  rowsInDb: number;
  problems: string[];
}

/**
 * One search under the spy. The test's own connection holds a read transaction open meanwhile,
 * so nothing (not even another process) can checkpoint and restart the WAL: every commit the
 * search makes stays countable in the file.
 */
async function measuredSearch(svc: any, g: GeneratedSearch, dbPath: string, test: DatabaseSync): Promise<MeasuredSearch> {
  const s = spy();
  s.query(test, "BEGIN");
  s.query(test, "SELECT count(*) FROM searches");
  const before = readWal(dbPath);
  await s.mark();
  const result = await svc.searchWithStatus(g.request);
  const stats = await s.collect();
  const walCommits = commitsBetween(before, readWal(dbPath));
  s.query(test, "COMMIT");
  const rowsInDb = Number(s.query(test, ROW_COUNT, result.searchId)[0].n);
  const problems = [...batchingProblems(stats, walCommits, rowsInDb), ...durabilityProblems(stats, dbPath), ...stats.violations];
  if (result.partial) problems.push(`expected every supplier ok: ${JSON.stringify(result.suppliers)}`);
  const { reads: _, ...counts } = stats;
  return { offers: result.total, stats: counts, walCommits, rowsInDb, problems };
}

const scenarios: Record<string, () => Promise<unknown>> = {
  /** Tests 1, 2 and 5: two searches at each size, on a fresh database per size. */
  async searches() {
    const out: Record<string, MeasuredSearch[]> = {};
    for (const size of args.sizes as number[]) {
      const g = dataset(size);
      const dbPath = freshDbPath();
      const svc = new app.FlightSearchService(clientsOf(g), { dbPath, parserThreads: 2 });
      const test = spy().open(dbPath, { readOnly: true });
      out[size] = [await measuredSearch(svc, g, dbPath, test), await measuredSearch(svc, g, dbPath, test)];
      await svc.close?.();
    }
    const [small, big] = (args.sizes as number[]).map((size) => out[size]);
    return {
      searches: out,
      prepareProblems: small && big ? prepareProblems(small[0].stats as SpyStats, big[0].stats as SpyStats, big[1].stats as SpyStats) : [],
    };
  },

  /** Tests 3 and 4: pages 1-3 of every sort, each getPage measured on its own. */
  async pages() {
    const s = spy();
    const limit = args.limit as number;
    const g = dataset(args.size);
    const dbPath = freshDbPath();
    const svc = new app.FlightSearchService(clientsOf(g), { dbPath, parserThreads: 2 });
    const { searchId, total } = await svc.searchWithStatus(g.request);
    const test = s.open(dbPath, { readOnly: true });
    // Rows per offer: the offer, its segments and its price rows.
    const k = 1 + Math.max(...referenceOffers(g.suppliers, g.request.passengers).map((it) => it.journeys.reduce((n, j) => n + j.segments.length, 0) + it.prices.length));
    const explain = (sql: string, params: unknown[]) =>
      s.query(test, `EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => String(r.detail));
    const calls = [];
    for (const sort of SORTS) {
      let cursor: string | undefined;
      for (let pageNo = 1; pageNo <= 3; pageNo++) {
        await s.mark();
        const page = await svc.getPage(searchId, { sort, limit, ...(cursor === undefined ? {} : { cursor }) });
        const stats = await s.collect();
        calls.push({
          sort,
          pageNo,
          offers: page.offers.length,
          rowsRead: stats.rowsRead,
          bytesRead: stats.bytesRead,
          planProblems: pagePlanProblems(stats.reads, explain, cursor !== undefined),
          readProblems: pageReadProblems(stats, limit, k, JSON.stringify(page).length),
        });
        cursor = page.nextCursor;
      }
    }
    await svc.close?.();
    return { total, k, calls };
  },

  /** Test 6: processing time from the last supplier answer to the first page, against R. */
  async budget() {
    const g = dataset(args.size, { carriers: undefined, preferredCarrier: undefined });
    const { referenceTime } = await import("./budget-reference.ts");
    const R = await referenceTime(app, g, freshDbPath());
    let lastAnswer = 0;
    const delays = [10, 20, 30];
    const clients = g.suppliers.map((sup, i) => ({
      name: sup.name,
      format: sup.format,
      search: () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            lastAnswer = Math.max(lastAnswer, performance.now());
            resolve(sup.raw);
          }, delays[i]),
        ),
    }));
    const svc = new app.FlightSearchService(clients, { dbPath: freshDbPath() });
    await svc.searchWithStatus(g.request); // warm-up: threads, statements, JIT
    const runs: number[] = [];
    for (let i = 0; i < 2; i++) {
      lastAnswer = 0;
      const result = await svc.searchWithStatus(g.request);
      runs.push(performance.now() - lastAnswer);
      if (result.partial) throw new Error(`expected every supplier ok: ${JSON.stringify(result.suppliers)}`);
    }
    await svc.close?.();
    return { R, runs, bound: Math.max(1000, 2.5 * R) };
  },

  /** Test 8: close() releases everything; this process must then exit by itself. */
  async close() {
    const g = dataset(args.size);
    const svc = new app.FlightSearchService(clientsOf(g), { dbPath: freshDbPath(), parserThreads: 2 });
    const { searchId, partial } = await svc.searchWithStatus(g.request);
    if (partial) throw new Error("expected every supplier ok");
    await svc.close();
    await svc.close();
    const rejects = async (call: () => Promise<unknown>) => {
      try {
        await call();
        return false;
      } catch {
        return true;
      }
    };
    return {
      searchRejects: await rejects(() => svc.searchWithStatus(g.request)),
      getPageRejects: await rejects(() => svc.getPage(searchId, {})),
    };
  },
};

const run = scenarios[name];
if (!run) throw new Error(`unknown scenario ${name}`);
printResult(await run());
// Only "close" must end on its own; the others may leave a service behind on purpose.
if (name !== "close") process.exit(0);
