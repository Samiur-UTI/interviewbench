import type { Itinerary } from "./types.ts";

/**
 * Identifies a trip: two itineraries with the same key are the same product. That needs the same
 * journeys and, segment by segment, the same flight, departure time and booking class (README
 * rule 3). Flight numbers alone merged business into economy and Monday's flight into Tuesday's.
 */
export function itineraryKey(it: Itinerary): string {
  return it.journeys
    .map((j) => j.segments.map((s) => `${s.flightNumber}@${s.departureUtc}/${s.bookingClass}`).join("+"))
    .join(" | ");
}

/** Result order: cheapest, then shortest, then preferred supplier, then supplierRef. */
export function compareItineraries(a: Itinerary, b: Itinerary, rank: (supplier: string) => number): number {
  return (
    a.totalPrice - b.totalPrice ||
    a.durationMinutes - b.durationMinutes ||
    rank(a.supplier) - rank(b.supplier) ||
    (a.supplierRef < b.supplierRef ? -1 : a.supplierRef > b.supplierRef ? 1 : 0)
  );
}

/**
 * Merges the itineraries from every supplier. Duplicates (same key) are shown once, at the
 * cheapest price; on a price tie the preferred supplier (earlier in `preference`) wins.
 *
 * One pass with a Map from key to the best offer so far, then one sort: O(n log n). (It used to
 * look keys up with Array#indexOf, which is O(n^2): 150k offers took over a minute.) Offers are
 * visited in the same order and the sort is stable, so the result is identical.
 */
export function mergeItineraries(lists: Itinerary[][], preference: readonly string[]): Itinerary[] {
  const ranks = new Map(preference.map((name, i) => [name, i] as const));
  const rank = (supplier: string): number => ranks.get(supplier) ?? preference.length;
  const best = new Map<string, Itinerary>();
  for (const list of lists) {
    for (const it of list) {
      const key = itineraryKey(it);
      const current = best.get(key);
      if (
        current === undefined ||
        it.totalPrice < current.totalPrice ||
        (it.totalPrice === current.totalPrice && rank(it.supplier) < rank(current.supplier))
      ) {
        best.set(key, it);
      }
    }
  }
  return [...best.values()].sort((a, b) => compareItineraries(a, b, rank));
}
