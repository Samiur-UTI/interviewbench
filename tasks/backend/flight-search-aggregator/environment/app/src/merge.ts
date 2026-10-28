import type { Itinerary } from "./types.ts";

/**
 * Identifies a trip (README rule 3): per journey and per segment, the marketing flight, its UTC
 * departure, its airports, booking code and cabin. Stored as `offers.trip_key`.
 */
export function itineraryKey(it: Itinerary): string {
  return it.journeys
    .map((j) => j.segments.map((s) => `${s.flightNumber}@${s.departureUtc}:${s.origin}-${s.destination}/${s.bookingCode}/${s.cabin}`).join(","))
    .join("|");
}

/** Cheapest first, then shortest, then by offer id (binary string order). */
export function compareItineraries(a: Itinerary, b: Itinerary): number {
  return a.totalPrice - b.totalPrice || a.durationMinutes - b.durationMinutes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Merges the itineraries from every supplier. Duplicates (same key) are shown once, at the
 * cheapest price; on a price tie the preferred supplier (earlier in `preference`) wins.
 */
export function mergeItineraries(lists: Itinerary[][], preference: readonly string[]): Itinerary[] {
  const ranks = new Map(preference.map((name, i) => [name, i]));
  const rank = (supplier: string): number => ranks.get(supplier) ?? preference.length;
  const best = new Map<string, Itinerary>();
  for (const list of lists) {
    for (const it of list) {
      const key = itineraryKey(it);
      const seen = best.get(key);
      if (!seen || it.totalPrice < seen.totalPrice || (it.totalPrice === seen.totalPrice && rank(it.supplier) < rank(seen.supplier))) {
        best.set(key, it);
      }
    }
  }
  return [...best.values()].sort(compareItineraries);
}
