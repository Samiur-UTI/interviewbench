// Reads and writes searches in the data team's schema (src/db/schema.ts).
import type { DatabaseSync } from "node:sqlite";
import { itineraryKey } from "../merge.ts";
import { comparePositions, prefRank, sortKeys } from "../paging.ts";
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
  pref_rank: number;
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

const sortableRow = (row: OfferRow) => ({
  id: row.offer_id,
  totalPrice: row.total_cents,
  durationMinutes: row.duration_min,
  stops: row.stops,
  prefRank: row.pref_rank,
});

/**
 * Straightforward first version: every row is its own statement and its own commit, and a page
 * is cut from the whole search sorted in memory.
 */
export class SearchStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Writes the search, its supplier statuses and its offers. Everything is committed on return. */
  saveSearch(search: NewSearch): void {
    const db = this.#db;
    const { searchId, request } = search;
    const preferred = request.preferredCarrier ?? null;
    db.prepare(INSERT_SEARCH).run(searchId, search.createdAtMs, JSON.stringify(request), preferred, search.status);
    for (const s of search.suppliers) {
      db.prepare(INSERT_SUPPLIER_RESULT).run(searchId, s.supplier, s.status, s.offers, s.error ?? null);
    }
    for (const it of search.offers) {
      db.prepare(INSERT_OFFER).run(
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
          db.prepare(INSERT_SEGMENT).run(
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
        db.prepare(INSERT_PRICE).run(searchId, it.id, p.paxType, p.count, p.unitTotalCents);
      }
    }
  }

  findSearch(searchId: string): StoredSearch | undefined {
    const row = this.#db.prepare("SELECT status, preferred_carrier FROM searches WHERE search_id = ?").get(searchId) as
      | { status: "complete" | "failed"; preferred_carrier: string | null }
      | undefined;
    return row && { status: row.status, preferredCarrier: row.preferred_carrier };
  }

  /** Up to `limit` offers of a search in `sort` order, starting strictly after `after`. */
  readPage(searchId: string, sort: SortPreference, after: Position | null, limit: number): PageRows {
    const rows = this.#db.prepare("SELECT * FROM offers WHERE search_id = ?").all(searchId) as unknown as OfferRow[];
    const ranked = rows
      .map((row) => ({ row, position: { keys: sortKeys(sortableRow(row), sort), offerId: row.offer_id } }))
      .sort((a, b) => comparePositions(a.position, b.position));
    const start = after ? ranked.findIndex((r) => comparePositions(r.position, after) > 0) : 0;
    const page = start === -1 ? [] : ranked.slice(start, start + limit);
    const more = start !== -1 && start + limit < ranked.length;
    return {
      offers: page.map((r) => this.#hydrate(searchId, r.row)),
      next: more ? page[page.length - 1].position : null,
    };
  }

  #hydrate(searchId: string, row: OfferRow): Offer {
    const segments = this.#db
      .prepare("SELECT * FROM offer_segments WHERE search_id = ? AND offer_id = ? ORDER BY leg_no, seg_no")
      .all(searchId, row.offer_id) as unknown as SegmentRow[];
    const prices = this.#db
      .prepare("SELECT * FROM offer_prices WHERE search_id = ? AND offer_id = ? ORDER BY pax_type")
      .all(searchId, row.offer_id) as unknown as PriceRow[];
    return toOffer(row, segments, prices);
  }
}
