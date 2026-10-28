// Owned by the data team. The price check and booking service reads these tables, and the same
// database holds the booking and orders tables, so the data team also sets the connection policy
// in openDatabase(). Keep table and column names and types. You may add indexes.
import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors.ts";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS searches (
  search_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  preferred_carrier TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete', 'failed'))
);

CREATE TABLE IF NOT EXISTS supplier_results (
  search_id TEXT NOT NULL,
  supplier TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'timeout')),
  offer_count INTEGER NOT NULL,
  error TEXT,
  PRIMARY KEY (search_id, supplier)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS offers (
  search_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,              -- public id of the winning copy: \`\${supplier}:\${supplierRef}\`
  trip_key TEXT NOT NULL,              -- dedup key (README, rule 3)
  supplier TEXT NOT NULL,
  supplier_ref TEXT NOT NULL,
  validating_carrier TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  base_cents INTEGER NOT NULL,
  taxes_cents INTEGER NOT NULL,
  fees_cents INTEGER NOT NULL,
  brand TEXT,
  duration_min INTEGER NOT NULL,
  stops INTEGER NOT NULL,
  pref_rank INTEGER NOT NULL,          -- 0 if validating_carrier = the search's preferred carrier, else 1
  first_departure_utc TEXT NOT NULL,
  seats INTEGER NOT NULL,
  PRIMARY KEY (search_id, offer_id),
  UNIQUE (search_id, trip_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS offer_segments (
  search_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  leg_no INTEGER NOT NULL,
  seg_no INTEGER NOT NULL,
  marketing_carrier TEXT NOT NULL,
  operating_carrier TEXT NOT NULL,
  flight_number TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  departure_utc TEXT NOT NULL,
  arrival_utc TEXT NOT NULL,
  booking_class TEXT NOT NULL,
  cabin TEXT NOT NULL,
  fare_basis TEXT NOT NULL,
  PRIMARY KEY (search_id, offer_id, leg_no, seg_no)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS offer_prices (
  search_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  pax_type TEXT NOT NULL,
  pax_count INTEGER NOT NULL,
  unit_total_cents INTEGER NOT NULL,   -- per passenger
  PRIMARY KEY (search_id, offer_id, pax_type)
) WITHOUT ROWID;

-- Used by the TTL job that deletes old searches.
CREATE INDEX IF NOT EXISTS searches_created ON searches (created_at_ms);

-- One index per sort preference, in that order and ending in the offer id (the tiebreak), so a
-- page is a range seek from the cursor position with no sorting step.
CREATE INDEX IF NOT EXISTS offers_cheapest ON offers (search_id, total_cents, duration_min, offer_id);
CREATE INDEX IF NOT EXISTS offers_fastest ON offers (search_id, duration_min, total_cents, offer_id);
CREATE INDEX IF NOT EXISTS offers_fewest_stops ON offers (search_id, stops, total_cents, offer_id);
CREATE INDEX IF NOT EXISTS offers_preferred_airline ON offers (search_id, pref_rank, total_cents, offer_id);
`;

/**
 * Opens (and if needed creates) the search database at `path`.
 *
 * Connection policy, set by the data team for everything in this database: WAL, so readers such
 * as the booking service see committed rows while we write, and synchronous=FULL, so a committed
 * row survives a power loss. Don't weaken either.
 */
export function openDatabase(path: string): DatabaseSync {
  if (typeof path !== "string" || path === "" || path === ":memory:") {
    throw new ValidationError("dbPath must be the path of a database file");
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA_SQL);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
