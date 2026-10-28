// One case of the spy self-test (spy-selftest.ts), run with `--import helpers/db-spy.mjs`.
// Each case does one thing a stage-3 solution could do and prints the problems the stage-3
// checks find, as one JSON line. "good-*" cases are controls and must find none.
//
// Usage: node --import ./db-spy.mjs spy-selftest-child.ts <case> <dbPath>
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { APP_DIR } from "./app.ts";
import { batchingProblems, durabilityProblems, pagePlanProblems, pageReadProblems } from "./db-checks.ts";
import type { SpyStats } from "./db-checks.ts";
import { makeItineraries } from "./offers.ts";
import { commitsBetween, readWal } from "./wal.ts";

const spy = (globalThis as any).__ibDbSpy;
if (!spy) throw new Error("run with --import helpers/db-spy.mjs");
const [name, dbPath] = process.argv.slice(2);

const { openDatabase } = await import(pathToFileURL(join(APP_DIR, "src", "db", "schema.ts")).href);
const SORT_INDEX = "CREATE INDEX IF NOT EXISTS t_cheapest ON offers (search_id, total_cents, duration_min, offer_id)";
const OFFER_SQL = `INSERT INTO offers (search_id, offer_id, trip_key, supplier, supplier_ref, validating_carrier,
  total_cents, base_cents, taxes_cents, fees_cents, brand, duration_min, stops, pref_rank, first_departure_utc, seats)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const offers = makeItineraries("caravel", 300, 7);
const offerArgs = (searchId: string, i: number) => {
  const it = offers[i];
  return [searchId, it.id, it.id, it.supplier, it.supplierRef, it.validatingCarrier, it.totalPrice, it.baseCents,
    it.taxesCents, it.feesCents, null, it.durationMinutes, it.stops, 1, it.journeys[0].segments[0].departureUtc, 9];
};
const literal = (v: unknown) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v)}'`);

const db: DatabaseSync = openDatabase(dbPath);
db.exec(SORT_INDEX);
const test = spy.open(dbPath, { readOnly: true });
const rowsOf = (searchId: string) => Number(spy.query(test, "SELECT count(*) AS n FROM offers WHERE search_id = ?", searchId)[0].n);

/**
 * Runs `write` for search `searchId` and returns what the batching and durability checks find.
 * A read transaction stays open on the test's connection meanwhile: it pins the WAL (which is
 * not empty here), so no checkpoint can restart it and every commit, from any process, stays
 * countable in the file.
 */
async function writeCase(searchId: string, write: () => unknown): Promise<string[]> {
  await spy.mark();
  test.exec("BEGIN");
  spy.query(test, "SELECT count(*) FROM searches");
  const before = readWal(dbPath);
  await write();
  const stats: SpyStats = await spy.collect();
  const walCommits = commitsBetween(before, readWal(dbPath));
  test.exec("COMMIT");
  const problems = batchingProblems(stats, walCommits, rowsOf(searchId));
  return [...problems, ...durabilityProblems(stats, dbPath), ...stats.violations];
}

/** Writes rows from another process, row by row, then checkpoints and pads the spied connection. */
function childProcessWithWalReset(): void {
  const rowsFile = `${dbPath}.rows.json`;
  writeFileSync(rowsFile, JSON.stringify(offers.slice(0, 50).map((_, i) => offerArgs("C", i))));
  const script = `const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA wal_autocheckpoint = 1");
    const insert = db.prepare(${JSON.stringify(OFFER_SQL)});
    for (const row of JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"))) insert.run(...row);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");`;
  spawnSync(process.execPath, ["--no-warnings", "-e", script, dbPath, rowsFile], { stdio: "inherit" });
  // As many changes on the spied connection as the child wrote, in one statement.
  db.exec("CREATE TEMP TABLE pad (x)");
  db.prepare("INSERT INTO pad SELECT value FROM json_each(?)").run(JSON.stringify(offers.slice(0, 50).map((_, i) => i)));
}

function seed(searchId: string): void {
  const insert = db.prepare(OFFER_SQL);
  db.exec("BEGIN IMMEDIATE");
  offers.forEach((_, i) => insert.run(...offerArgs(searchId, i)));
  db.exec("COMMIT");
}

/** Reads page 3 (limit 50) of search P through `read` and returns what the plan check finds. */
async function pageCase(read: (cursor: unknown[]) => unknown): Promise<string[]> {
  const cursor = [offers[0].totalPrice, 0, ""];
  await spy.mark();
  read(cursor);
  const stats: SpyStats = await spy.collect();
  const explain = (sql: string, params: unknown[]) =>
    spy.query(test, `EXPLAIN QUERY PLAN ${sql}`, ...params).map((r: { detail: string }) => r.detail);
  return pagePlanProblems(stats.reads, explain, true);
}

const workerUrl = new URL("./spy-selftest-worker.ts", import.meta.url);
const runWorker = (options: object, tagStore = false) =>
  new Promise<void>((resolve, reject) => {
    const w = new Worker(workerUrl, { ...options, workerData: { dbPath, searchId: "W", count: 50, tagStore } });
    w.once("error", reject);
    w.once("exit", () => resolve());
  });

const cases: Record<string, () => Promise<string[]>> = {
  "good-transaction": () => writeCase("G", () => seed("G")),
  "worker-execargv": () => writeCase("W", () => runWorker({ execArgv: [] })),
  "worker-no-warnings": () => writeCase("W", () => runWorker({ execArgv: ["--no-warnings"] })),
  "worker-tag-store": () => writeCase("W", () => runWorker({ execArgv: [] }, true)),
  "eval-worker": () =>
    writeCase("E", () => {
      try {
        new Worker("1", { eval: true });
      } catch {
        // refused by the spy, which records a violation
      }
    }),
  "tag-store": () =>
    writeCase("T", () => {
      const sql = db.createTagStore();
      for (let i = 0; i < 50; i++) {
        const [s, id, key, sup, ref, vc, t, b, x, f, br, d, st, pr, dep, seats] = offerArgs("T", i);
        sql.run`INSERT INTO offers VALUES (${s}, ${id}, ${key}, ${sup}, ${ref}, ${vc}, ${t}, ${b}, ${x}, ${f}, ${br}, ${d}, ${st}, ${pr}, ${dep}, ${seats})`;
      }
    }),
  "multi-statement-exec": () =>
    writeCase("X", () => {
      const script = offers.slice(0, 100).map((_, i) => `INSERT INTO offers VALUES (${offerArgs("X", i).map(literal).join(", ")})`);
      db.exec(script.join(";\n"));
    }),
  "child-process": () =>
    writeCase("C", () => {
      const script = `const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(${JSON.stringify(dbPath)});
        db.exec("BEGIN; ${offers
          .slice(0, 20)
          .map((_, i) => `INSERT INTO offers VALUES (${offerArgs("C", i).map(literal).join(", ")})`)
          .join("; ")}; COMMIT");`;
      spawnSync(process.execPath, ["--no-warnings", "-e", script], { stdio: "inherit" });
    }),
  "child-process-wal-reset": () => writeCase("C", childProcessWithWalReset),
  "transaction-per-row": () =>
    writeCase("R", () => {
      db.exec("PRAGMA wal_autocheckpoint = 1"); // restarts the WAL; the spy counts commits too
      const [begin, commit, insert] = [db.prepare("BEGIN"), db.prepare("COMMIT"), db.prepare(OFFER_SQL)];
      offers.forEach((_, i) => {
        begin.run();
        insert.run(...offerArgs("R", i));
        commit.run();
      });
    }),
  "tag-store-prototype": () =>
    writeCase("T", () => {
      const sql = db.createTagStore();
      const run = Object.getPrototypeOf(sql).run; // the store's own prototype, not the instance
      for (let i = 0; i < 50; i++) {
        const args = offerArgs("T", i);
        run.call(sql, ["INSERT INTO offers VALUES (", ...Array(args.length - 1).fill(", "), ")"], ...args);
      }
    }),
  "memory-database": () =>
    writeCase("M", () => {
      const mem = new DatabaseSync(":memory:");
      mem.exec("CREATE TABLE t (a)");
    }),
  "pragma-synchronous-off": () => writeCase("S", () => db.exec("pragma main.synchronous = off")),
  "good-page": () => {
    seed("P");
    return pageCase((k) =>
      db.prepare(`SELECT * FROM offers WHERE search_id = ? AND (total_cents, duration_min, offer_id) > (?, ?, ?)
        ORDER BY total_cents, duration_min, offer_id LIMIT 51`).all("P", ...(k as [number, number, string])),
    );
  },
  "json-group-array-page": () => {
    seed("P");
    return pageCase(() =>
      db.prepare("SELECT json_group_array(json_array(offer_id, total_cents, duration_min)) AS j FROM offers WHERE search_id = ?").get("P"),
    );
  },
  "expanded-or-page": () => {
    seed("P");
    return pageCase((cursor) => {
      const [t, d, id] = cursor as [number, number, string];
      return db.prepare(`SELECT * FROM offers WHERE search_id = ? AND (total_cents > ? OR (total_cents = ? AND (duration_min > ?
        OR (duration_min = ? AND offer_id > ?)))) ORDER BY total_cents, duration_min, offer_id LIMIT 51`).all("P", t, t, d, d, id);
    }
    );
  },
  "limit-without-order-page": () => {
    seed("P");
    return pageCase(() => db.prepare("SELECT * FROM offers WHERE search_id = ? LIMIT 100000").all("P"));
  },
  "offset-page": () => {
    seed("P");
    return pageCase(() =>
      db.prepare("SELECT * FROM offers WHERE search_id = ? ORDER BY total_cents, duration_min, offer_id LIMIT 51 OFFSET ?").all("P", 100),
    );
  },
  "page-from-memory": () => pageCase(() => undefined),
  "user-function-page": async () => {
    seed("P");
    const rest: unknown[] = [];
    // Overrides a built-in, so the test's own connection can still EXPLAIN the query.
    db.function("json_array", { varargs: true }, (...row: unknown[]) => rest.push(row));
    await spy.mark();
    db.prepare(`SELECT count(json_array(offer_id, supplier_ref, total_cents, duration_min, first_departure_utc)) AS n
      FROM offers WHERE search_id = ? AND (total_cents, duration_min, offer_id) > (?, ?, ?)`).get("P", 0, 0, "");
    const stats: SpyStats = await spy.collect();
    return pageReadProblems(stats, 10, 3, 2000);
  },
};

const run = cases[name];
if (!run) throw new Error(`unknown case ${name}`);
console.log(JSON.stringify({ name, problems: await run() }));
db.close();
test.close();
