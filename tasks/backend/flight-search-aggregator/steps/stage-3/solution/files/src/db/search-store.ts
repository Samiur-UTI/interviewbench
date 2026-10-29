// Reads and writes searches in the data team's schema (src/db/schema.ts).
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { itineraryKey } from "../merge.ts";
import { prefRank } from "../paging.ts";
import type { Position } from "../paging.ts";
import type { SupplierStatus } from "../search-service.ts";
import { minutesBetween } from "../time.ts";
import type { Cabin, Itinerary, Journey, PaxPrice, PaxType, SearchRequest, Segment, SortPreference } from "../types.ts";

/** An offer as read back from the database: exactly the itinerary that was stored. */
export interface Offer extends Itinerary {}

export interface NewSearch {
  searchId: string;
  createdAtMs: number;
  request: SearchRequest;
  status: "complete" | "failed";
  suppliers: SupplierStatus[];
  offers: Itinerary[]; // seat-filtered and de-duplicated: what the customer is shown
}

export interface StoredSearch {
  status: "complete" | "failed";
  preferredCarrier: string | null;
}

export interface PageRows {
  offers: Offer[];
  next: Position | null; // position of the last offer, if more offers follow it
}

interface OfferRow {
  k1: number; // the two sort keys of the page's order
  k2: number;
  offer_id: string;
  supplier: string;
  supplier_ref: string;
  validating_carrier: string;
  total_cents: number;
  base_cents: number;
  taxes_cents: number;
  fees_cents: number;
  brand: string | null;
  duration_min: number;
  stops: number;
  seats: number;
}

interface SegmentRow {
  offer_id: string;
  leg_no: number;
  seg_no: number;
  marketing_carrier: string;
  operating_carrier: string;
  flight_number: string;
  origin: string;
  destination: string;
  departure_utc: string;
  arrival_utc: string;
  booking_class: string;
  cabin: string;
  fare_basis: string;
}

interface PriceRow {
  offer_id: string;
  pax_type: string;
  pax_count: number;
  unit_total_cents: number;
}

const INSERT_SEARCH = `INSERT INTO searches (search_id, created_at_ms, request_json, preferred_carrier, status)
  VALUES (?, ?, ?, ?, ?)`;
const INSERT_SUPPLIER_RESULT = `INSERT INTO supplier_results (search_id, supplier, status, offer_count, error)
  VALUES (?, ?, ?, ?, ?)`;
const INSERT_OFFER = `INSERT INTO offers (search_id, offer_id, trip_key, supplier, supplier_ref, validating_carrier,
    total_cents, base_cents, taxes_cents, fees_cents, brand, duration_min, stops, pref_rank, first_departure_utc, seats)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_SEGMENT = `INSERT INTO offer_segments (search_id, offer_id, leg_no, seg_no, marketing_carrier,
    operating_carrier, flight_number, origin, destination, departure_utc, arrival_utc, booking_class, cabin, fare_basis)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_PRICE = `INSERT INTO offer_prices (search_id, offer_id, pax_type, pax_count, unit_total_cents)
  VALUES (?, ?, ?, ?, ?)`;

/** Sort columns per order. Each order has an index on (search_id, k1, k2, offer_id) in the schema. */
const SORT_COLUMNS: Record<SortPreference, [k1: string, k2: string]> = {
  cheapest: ["total_cents", "duration_min"],
  fastest: ["duration_min", "total_cents"],
  fewest_stops: ["stops", "total_cents"],
  preferred_airline: ["pref_rank", "total_cents"],
};

const OFFER_COLUMNS = `offer_id, supplier, supplier_ref, validating_carrier, total_cents, base_cents, taxes_cents,
  fees_cents, brand, duration_min, stops, seats`;

/** Rebuilds an itinerary from its rows. Journey durations are derived from the segments. */
function toOffer(row: OfferRow, segments: SegmentRow[], prices: PriceRow[]): Offer {
  const journeys: Journey[] = [];
  for (const s of segments) {
    const segment: Segment = {
      marketingCarrier: s.marketing_carrier,
      flightNumber: s.flight_number,
      operatingCarrier: s.operating_carrier,
      origin: s.origin,
      destination: s.destination,
      departureUtc: s.departure_utc,
      arrivalUtc: s.arrival_utc,
      bookingCode: s.booking_class,
      cabin: s.cabin as Cabin,
      fareBasis: s.fare_basis,
    };
    (journeys[s.leg_no] ??= { segments: [], durationMinutes: 0 }).segments.push(segment);
  }
  for (const j of journeys) {
    j.durationMinutes = minutesBetween(j.segments[0].departureUtc, j.segments[j.segments.length - 1].arrivalUtc);
  }
  const offer: Offer = {
    id: row.offer_id,
    supplier: row.supplier,
    supplierRef: row.supplier_ref,
    validatingCarrier: row.validating_carrier,
    journeys,
    totalPrice: row.total_cents,
    baseCents: row.base_cents,
    taxesCents: row.taxes_cents,
    feesCents: row.fees_cents,
    prices: prices.map(
      (p): PaxPrice => ({ paxType: p.pax_type as PaxType, count: p.pax_count, unitTotalCents: p.unit_total_cents }),
    ),
    seatsAvailable: row.seats,
    durationMinutes: row.duration_min,
    stops: row.stops,
  };
  if (row.brand !== null) offer.brand = row.brand;
  return offer;
}

/** Groups rows by offer id, keeping their order. */
function byOffer<T extends { offer_id: string }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.offer_id);
    if (group) group.push(row);
    else groups.set(row.offer_id, [row]);
  }
  return groups;
}

/**
 * A search is written in one transaction with statements prepared once per connection. A page
 * is one index range seek (keyset pagination) plus two primary-key lookups for its children.
 */
export class SearchStore {
  readonly #db: DatabaseSync;
  readonly #insertSearch: StatementSync;
  readonly #insertSupplierResult: StatementSync;
  readonly #insertOffer: StatementSync;
  readonly #insertSegment: StatementSync;
  readonly #insertPrice: StatementSync;
  readonly #findSearch: StatementSync;
  readonly #pageSegments: StatementSync;
  readonly #pagePrices: StatementSync;
  readonly #firstPage = new Map<SortPreference, StatementSync>();
  readonly #nextPage = new Map<SortPreference, StatementSync>();

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#insertSearch = db.prepare(INSERT_SEARCH);
    this.#insertSupplierResult = db.prepare(INSERT_SUPPLIER_RESULT);
    this.#insertOffer = db.prepare(INSERT_OFFER);
    this.#insertSegment = db.prepare(INSERT_SEGMENT);
    this.#insertPrice = db.prepare(INSERT_PRICE);
    this.#findSearch = db.prepare("SELECT status, preferred_carrier FROM searches WHERE search_id = ?");
    // The page's offer ids are bound as one JSON array, so each lookup stays one prepared statement.
    this.#pageSegments = db.prepare(`SELECT * FROM offer_segments
      WHERE search_id = ? AND offer_id IN (SELECT value FROM json_each(?))
      ORDER BY offer_id, leg_no, seg_no`);
    this.#pagePrices = db.prepare(`SELECT * FROM offer_prices
      WHERE search_id = ? AND offer_id IN (SELECT value FROM json_each(?))
      ORDER BY offer_id, pax_type`);
    for (const [sort, [k1, k2]] of Object.entries(SORT_COLUMNS) as [SortPreference, [string, string]][]) {
      const select = `SELECT ${k1} AS k1, ${k2} AS k2, ${OFFER_COLUMNS} FROM offers WHERE search_id = ?`;
      const order = `ORDER BY ${k1}, ${k2}, offer_id LIMIT ?`;
      this.#firstPage.set(sort, db.prepare(`${select} ${order}`));
      // A row-value comparison, so SQLite seeks straight to the cursor position in the index.
      this.#nextPage.set(sort, db.prepare(`${select} AND (${k1}, ${k2}, offer_id) > (?, ?, ?) ${order}`));
    }
  }

  /**
   * Writes the search, its supplier statuses and its offers in one transaction; everything is
   * committed on return. BEGIN IMMEDIATE takes the write lock up front, so a concurrent writer
   * waits (busy_timeout) instead of failing when a deferred transaction tries to upgrade.
   */
  saveSearch(search: NewSearch): void {
    const { searchId, request } = search;
    const preferred = request.preferredCarrier ?? null;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#insertSearch.run(searchId, search.createdAtMs, JSON.stringify(request), preferred, search.status);
      for (const s of search.suppliers) {
        this.#insertSupplierResult.run(searchId, s.supplier, s.status, s.offers, s.error ?? null);
      }
      for (const it of search.offers) {
        this.#insertOffer.run(
          searchId,
          it.id,
          itineraryKey(it),
          it.supplier,
          it.supplierRef,
          it.validatingCarrier,
          it.totalPrice,
          it.baseCents,
          it.taxesCents,
          it.feesCents,
          it.brand ?? null,
          it.durationMinutes,
          it.stops,
          prefRank(it, preferred),
          it.journeys[0].segments[0].departureUtc,
          it.seatsAvailable,
        );
        it.journeys.forEach((journey, legNo) => {
          journey.segments.forEach((s, segNo) => {
            this.#insertSegment.run(
              searchId,
              it.id,
              legNo,
              segNo,
              s.marketingCarrier,
              s.operatingCarrier,
              s.flightNumber,
              s.origin,
              s.destination,
              s.departureUtc,
              s.arrivalUtc,
              s.bookingCode,
              s.cabin,
              s.fareBasis,
            );
          });
        });
        for (const p of it.prices) {
          this.#insertPrice.run(searchId, it.id, p.paxType, p.count, p.unitTotalCents);
        }
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  findSearch(searchId: string): StoredSearch | undefined {
    const row = this.#findSearch.get(searchId) as { status: "complete" | "failed"; preferred_carrier: string | null } | undefined;
    return row && { status: row.status, preferredCarrier: row.preferred_carrier };
  }

  /** Up to `limit` offers of a search in `sort` order, starting strictly after `after`. */
  readPage(searchId: string, sort: SortPreference, after: Position | null, limit: number): PageRows {
    // One row more than the page shows tells us whether another page follows.
    const rows = (
      after
        ? this.#nextPage.get(sort)!.all(searchId, after.keys[0], after.keys[1], after.offerId, limit + 1)
        : this.#firstPage.get(sort)!.all(searchId, limit + 1)
    ) as unknown as OfferRow[];
    const more = rows.length > limit;
    if (more) rows.pop();
    if (rows.length === 0) return { offers: [], next: null };

    const ids = JSON.stringify(rows.map((r) => r.offer_id));
    const segments = byOffer(this.#pageSegments.all(searchId, ids) as unknown as SegmentRow[]);
    const prices = byOffer(this.#pagePrices.all(searchId, ids) as unknown as PriceRow[]);
    const offers = rows.map((r) => toOffer(r, segments.get(r.offer_id) ?? [], prices.get(r.offer_id) ?? []));
    const last = rows[rows.length - 1];
    return { offers, next: more ? { keys: [last.k1, last.k2], offerId: last.offer_id } : null };
  }
}
