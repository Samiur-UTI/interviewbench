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
 */
export function mergeItineraries(lists: Itinerary[][], preference: readonly string[]): Itinerary[] {
  const rank = (supplier: string): number => {
    const i = preference.indexOf(supplier);
    return i === -1 ? preference.length : i;
  };
  const keys: string[] = [];
  const best: Itinerary[] = [];
  for (const list of lists) {
    for (const it of list) {
      const key = itineraryKey(it);
      const i = keys.indexOf(key);
      if (i === -1) {
        keys.push(key);
        best.push(it);
      } else if (
        it.totalPrice < best[i].totalPrice ||
        (it.totalPrice === best[i].totalPrice && rank(it.supplier) < rank(best[i].supplier))
      ) {
        best[i] = it;
      }
    }
  }
  return best.sort((a, b) => compareItineraries(a, b, rank));
}
