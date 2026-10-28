// Worker for the spy self-test: writes `count` offers row by row (autocommit) from its own
// connection, through a prepared statement or a tag store (`tagStore`). Started with an
// `execArgv` that would drop an inherited --import preload.
import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";

const { dbPath, searchId, count, tagStore } = workerData as { dbPath: string; searchId: string; count: number; tagStore: boolean };
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
const insert = db.prepare(`INSERT INTO offers (search_id, offer_id, trip_key, supplier, supplier_ref, validating_carrier,
  total_cents, base_cents, taxes_cents, fees_cents, duration_min, stops, pref_rank, first_departure_utc, seats)
  VALUES (?, ?, ?, 'w', 'r', 'XB', 1000, 800, 200, 0, 60, 0, 1, '2026-12-01T00:00:00.000Z', 9)`);
const sql = db.createTagStore();
for (let i = 0; i < count; i++) {
  if (tagStore) {
    sql.run`INSERT INTO offers (search_id, offer_id, trip_key, supplier, supplier_ref, validating_carrier, total_cents,
      base_cents, taxes_cents, fees_cents, duration_min, stops, pref_rank, first_departure_utc, seats)
      VALUES (${searchId}, ${`w:${i}`}, ${`k${i}`}, 'w', 'r', 'XB', 1000, 800, 200, 0, 60, 0, 1, '2026-12-01T00:00:00.000Z', 9)`;
  } else {
    insert.run(searchId, `w:${i}`, `k${i}`);
  }
}
db.close();
