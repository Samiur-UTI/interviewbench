import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FlightSearchService, ValidationError } from "../src/index.ts";
import { openDatabase } from "../src/db/schema.ts";
import type { SearchRequest, SupplierClient, SupplierFormat } from "../src/index.ts";

const fixture = (format: SupplierFormat): string => readFileSync(new URL(`./fixtures/${format}-dxb-sin.json`, import.meta.url), "utf8");
const client = (format: SupplierFormat, raw: () => string = () => fixture(format)): SupplierClient => ({
  name: format,
  format,
  search: async () => raw(),
});
const request: SearchRequest = {
  tripType: "return",
  legs: [
    { origin: "DXB", destination: "SIN", date: "2026-12-01" },
    { origin: "SIN", destination: "DXB", date: "2026-12-08" },
  ],
  passengers: { adults: 2, children: 1 },
};
const dbPath = () => join(mkdtempSync(join(tmpdir(), "flight-search-")), "search.db");

test("every sort's page query seeks through an index, with no sorting step", () => {
  const path = dbPath();
  openDatabase(path).close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    for (const [k1, k2] of [
      ["total_cents", "duration_min"],
      ["duration_min", "total_cents"],
      ["stops", "total_cents"],
      ["pref_rank", "total_cents"],
    ]) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT * FROM offers WHERE search_id = ? AND (${k1}, ${k2}, offer_id) > (?, ?, ?)
          ORDER BY ${k1}, ${k2}, offer_id LIMIT 51`)
        .all("s", 0, 0, "")
        .map((r) => String(r.detail))
        .join(" | ");
      assert.match(plan, new RegExp(`SEARCH offers USING INDEX \\w+ \\(search_id=\\? AND \\(${k1},${k2},offer_id\\)>\\(\\?,\\?,\\?\\)\\)`), plan);
      assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
    }
  } finally {
    db.close();
  }
});

test("parserThreads must be a positive integer", () => {
  for (const parserThreads of [0, -1, 1.5, "2"]) {
    assert.throws(
      () => new FlightSearchService([client("caravel")], { dbPath: dbPath(), parserThreads: parserThreads as number }),
      ValidationError,
    );
  }
});

test("a payload that fails to parse in a thread is a supplier error, and the next search works", async () => {
  let tessera = "{ not json";
  const svc = new FlightSearchService([client("caravel"), client("tessera", () => tessera)], { dbPath: dbPath(), parserThreads: 1 });
  try {
    const first = await svc.searchWithStatus(request);
    assert.deepEqual(first.suppliers.map((s) => s.status), ["ok", "error"]);
    tessera = fixture("tessera");
    const second = await svc.searchWithStatus(request);
    assert.equal(second.partial, false);
  } finally {
    await svc.close();
  }
});

test("close() is idempotent, and later calls reject", async () => {
  const svc = new FlightSearchService([client("caravel")], { dbPath: dbPath(), parserThreads: 1 });
  const { searchId } = await svc.searchWithStatus(request);
  await svc.close();
  await svc.close();
  await assert.rejects(async () => svc.searchWithStatus(request));
  await assert.rejects(async () => svc.getPage(searchId, {}));
});
