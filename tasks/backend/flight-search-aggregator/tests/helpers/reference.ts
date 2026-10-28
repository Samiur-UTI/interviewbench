// Reference behaviour, kept in sync with the reference solutions (steps/stage-*/solution/).
// Parsing is covered by the generator (payloads.ts renders offers and the Itinerary objects they
// must become); this file holds the reference merge and the search pipeline built on it.
import type { ExpectedItinerary } from "./payloads.ts";

type It = ExpectedItinerary;

export function referenceKey(it: It): string {
  return it.journeys
    .map((j) => j.segments.map((s) => `${s.flightNumber}@${s.departureUtc}/${s.bookingClass}`).join("+"))
    .join(" | ");
}

/** O(n log n): one pass keeping the best offer per key, then one stable sort. */
export function referenceMerge(lists: It[][], preference: readonly string[]): It[] {
  const ranks = new Map(preference.map((name, i) => [name, i]));
  const rank = (s: string) => ranks.get(s) ?? preference.length;
  const best = new Map<string, It>();
  for (const list of lists) {
    for (const it of list) {
      const key = referenceKey(it);
      const cur = best.get(key);
      if (!cur || it.totalPrice < cur.totalPrice || (it.totalPrice === cur.totalPrice && rank(it.supplier) < rank(cur.supplier))) {
        best.set(key, it);
      }
    }
  }
  return [...best.values()].sort(
    (a, b) =>
      a.totalPrice - b.totalPrice ||
      a.durationMinutes - b.durationMinutes ||
      rank(a.supplier) - rank(b.supplier) ||
      (a.supplierRef < b.supplierRef ? -1 : a.supplierRef > b.supplierRef ? 1 : 0),
  );
}

/** Expected `itineraries` of a search: seat filter per supplier, then merge in client order. */
export function referenceSearch(perClient: { name: string; itineraries: It[] }[], passengers: number): It[] {
  return referenceMerge(
    perClient.map((c) => c.itineraries.filter((it) => it.seatsAvailable >= passengers)),
    perClient.map((c) => c.name),
  );
}
