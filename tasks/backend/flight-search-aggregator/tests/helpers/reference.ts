// Reference behaviour for stages 2 and 3: which offers a search stores, in which orders they are
// paged, and the exact rows the data team's schema should hold. Kept in sync with the README.
import { tripKey } from "./payloads.ts";
import type { ExpectedItinerary, Passengers, SearchRequest, SortPreference } from "./payloads.ts";

type It = ExpectedItinerary;

export const SORTS: readonly SortPreference[] = ["cheapest", "fastest", "fewest_stops", "preferred_airline"];

/** README rules 1 and 4: seat check per supplier, then one offer per trip, cheapest (then earlier supplier). */
export function referenceOffers(suppliers: { name: string; itineraries: It[] }[], passengers: Passengers): It[] {
  const seats = passengers.adults + passengers.children;
  const best = new Map<string, { it: It; rank: number }>();
  suppliers.forEach((s, rank) => {
    for (const it of s.itineraries) {
      if (it.seatsAvailable < seats) continue;
      const key = tripKey(it);
      const seen = best.get(key);
      if (!seen || it.totalPrice < seen.it.totalPrice || (it.totalPrice === seen.it.totalPrice && rank < seen.rank)) {
        best.set(key, { it, rank });
      }
    }
  });
  return [...best.values()].map((b) => b.it);
}

export const prefRank = (it: It, preferredCarrier: string | undefined): number =>
  preferredCarrier !== undefined && it.validatingCarrier === preferredCarrier ? 0 : 1;

/** The cursor keys of README rule 5 / the stage-2 brief: [key1, key2, offerId]. */
export function sortKeys(it: It, sort: SortPreference, preferredCarrier?: string): [number, number, string] {
  switch (sort) {
    case "cheapest":
      return [it.totalPrice, it.durationMinutes, it.id];
    case "fastest":
      return [it.durationMinutes, it.totalPrice, it.id];
    case "fewest_stops":
      return [it.stops, it.totalPrice, it.id];
    case "preferred_airline":
      return [prefRank(it, preferredCarrier), it.totalPrice, it.id];
  }
}

export function compareKeys(a: [number, number, string], b: [number, number, string]): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

export function referenceOrder(offers: It[], sort: SortPreference, preferredCarrier?: string): It[] {
  return [...offers].sort((a, b) => compareKeys(sortKeys(a, sort, preferredCarrier), sortKeys(b, sort, preferredCarrier)));
}

/**
 * Rows of every table for one search, sorted by primary key, without the columns whose values
 * the brief leaves open: `searches.request_json`, `searches.created_at_ms`, `supplier_results.error`.
 */
export interface ReferenceRows {
  searches: Record<string, unknown>[];
  supplier_results: Record<string, unknown>[];
  offers: Record<string, unknown>[];
  offer_segments: Record<string, unknown>[];
  offer_prices: Record<string, unknown>[];
}

export interface SupplierOutcome {
  supplier: string;
  status: "ok" | "error" | "timeout";
  offerCount: number;
}

export function referenceRows(
  searchId: string,
  request: SearchRequest,
  outcomes: SupplierOutcome[],
  offers: It[],
): ReferenceRows {
  const failed = outcomes.every((o) => o.status !== "ok");
  const byPk = <T extends Record<string, unknown>>(rows: T[], ...cols: string[]) =>
    rows.sort((a, b) => {
      for (const c of cols) {
        const x = a[c] as string | number;
        const y = b[c] as string | number;
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    });
  return {
    searches: [
      { search_id: searchId, preferred_carrier: request.preferredCarrier ?? null, status: failed ? "failed" : "complete" },
    ],
    supplier_results: byPk(
      outcomes.map((o) => ({ search_id: searchId, supplier: o.supplier, status: o.status, offer_count: o.offerCount })),
      "supplier",
    ),
    offers: byPk(
      offers.map((it) => ({
        search_id: searchId,
        offer_id: it.id,
        trip_key: tripKey(it),
        supplier: it.supplier,
        supplier_ref: it.supplierRef,
        validating_carrier: it.validatingCarrier,
        total_cents: it.totalPrice,
        base_cents: it.baseCents,
        taxes_cents: it.taxesCents,
        fees_cents: it.feesCents,
        brand: it.brand ?? null,
        duration_min: it.durationMinutes,
        stops: it.stops,
        pref_rank: prefRank(it, request.preferredCarrier),
        first_departure_utc: it.journeys[0].segments[0].departureUtc,
        seats: it.seatsAvailable,
      })),
      "offer_id",
    ),
    offer_segments: byPk(
      offers.flatMap((it) =>
        it.journeys.flatMap((j, legNo) =>
          j.segments.map((s, segNo) => ({
            search_id: searchId,
            offer_id: it.id,
            leg_no: legNo,
            seg_no: segNo,
            marketing_carrier: s.marketingCarrier,
            operating_carrier: s.operatingCarrier,
            flight_number: s.flightNumber,
            origin: s.origin,
            destination: s.destination,
            departure_utc: s.departureUtc,
            arrival_utc: s.arrivalUtc,
            booking_class: s.bookingCode,
            cabin: s.cabin,
            fare_basis: s.fareBasis,
          })),
        ),
      ),
      "offer_id",
      "leg_no",
      "seg_no",
    ),
    offer_prices: byPk(
      offers.flatMap((it) =>
        it.prices.map((p) => ({
          search_id: searchId,
          offer_id: it.id,
          pax_type: p.paxType,
          pax_count: p.count,
          unit_total_cents: p.unitTotalCents,
        })),
      ),
      "offer_id",
      "pax_type",
    ),
  };
}

/** The same tables as read from the database, in the same shape and order. */
export const TABLE_QUERIES: Record<keyof ReferenceRows, string> = {
  searches: "SELECT search_id, preferred_carrier, status FROM searches WHERE search_id = ?",
  supplier_results: "SELECT search_id, supplier, status, offer_count FROM supplier_results WHERE search_id = ? ORDER BY supplier",
  offers: `SELECT search_id, offer_id, trip_key, supplier, supplier_ref, validating_carrier, total_cents, base_cents,
    taxes_cents, fees_cents, brand, duration_min, stops, pref_rank, first_departure_utc, seats
    FROM offers WHERE search_id = ? ORDER BY offer_id`,
  offer_segments: `SELECT search_id, offer_id, leg_no, seg_no, marketing_carrier, operating_carrier, flight_number, origin,
    destination, departure_utc, arrival_utc, booking_class, cabin, fare_basis
    FROM offer_segments WHERE search_id = ? ORDER BY offer_id, leg_no, seg_no`,
  offer_prices: "SELECT search_id, offer_id, pax_type, pax_count, unit_total_cents FROM offer_prices WHERE search_id = ? ORDER BY offer_id, pax_type",
};
