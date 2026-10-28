// R for the stage-3 budget test: how long the work after the last supplier answer takes on this
// machine when done plainly and well, in this process. Parse each payload (the app's own
// parsers), seat-filter and merge (the app's merge), write every row in one BEGIN IMMEDIATE
// transaction with statements prepared once, then read the first page through an index.
import { DatabaseSync } from "node:sqlite";
import type { App } from "./app.ts";
import type { ExpectedItinerary, GeneratedSearch } from "./payloads.ts";
import { referenceRows } from "./reference.ts";
import type { ReferenceRows } from "./reference.ts";

const INDEXES = "CREATE INDEX IF NOT EXISTS ref_cheapest ON offers (search_id, total_cents, duration_min, offer_id)";

function insertAll(db: DatabaseSync, rows: ReferenceRows, created: Set<string>): void {
  db.exec("BEGIN IMMEDIATE");
  for (const [table, list] of Object.entries(rows)) {
    if (list.length === 0) continue;
    const cols = Object.keys(list[0]);
    if (!created.has(table)) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${cols.join(", ")})`);
      created.add(table);
    }
    const insert = db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const row of list) insert.run(...(Object.values(row) as (string | number | null)[]));
  }
  db.exec("COMMIT");
}

/** Best of two runs, in milliseconds, on a scratch database file at `dbPath`. */
export async function referenceTime(app: App, g: GeneratedSearch, dbPath: string): Promise<number> {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  const created = new Set<string>();
  const seats = g.request.passengers.adults + g.request.passengers.children;
  let best = Infinity;
  for (let run = 0; run < 2; run++) {
    const start = performance.now();
    const lists: ExpectedItinerary[][] = g.suppliers.map((s) =>
      app.parsePayload(s.format, s.raw, s.name).filter((it: ExpectedItinerary) => it.seatsAvailable >= seats),
    );
    const offers: ExpectedItinerary[] = app.mergeItineraries(lists, g.suppliers.map((s) => s.name));
    const outcomes = g.suppliers.map((s, i) => ({ supplier: s.name, status: "ok" as const, offerCount: lists[i].length }));
    insertAll(db, referenceRows(`ref-${run}`, g.request, outcomes, offers), created);
    if (run === 0) db.exec(INDEXES);
    db.prepare("SELECT * FROM offers WHERE search_id = ? ORDER BY total_cents, duration_min, offer_id LIMIT 51").all(`ref-${run}`);
    best = Math.min(best, performance.now() - start);
  }
  db.close();
  return best;
}
