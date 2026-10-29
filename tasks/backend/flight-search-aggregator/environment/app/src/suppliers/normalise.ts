import { SupplierPayloadError } from "../errors.ts";
import { minutesBetween } from "../time.ts";
import type { Journey, PaxPrice, Segment } from "../types.ts";

/** A journey from its segments, in flight order. */
export function toJourney(segments: Segment[], path: string): Journey {
  if (segments.length === 0) throw new SupplierPayloadError(`${path} has no segments`);
  return {
    segments,
    durationMinutes: minutesBetween(segments[0].departureUtc, segments[segments.length - 1].arrivalUtc),
  };
}

/** The itinerary-level figures derived from its journeys. */
export function journeyTotals(journeys: Journey[]): { durationMinutes: number; stops: number } {
  let durationMinutes = 0;
  let stops = 0;
  for (const j of journeys) {
    durationMinutes += j.durationMinutes;
    stops += j.segments.length - 1;
  }
  return { durationMinutes, stops };
}

/** Prices per passenger type, adults first. Each type may appear only once. */
export function byPaxType(prices: PaxPrice[], path: string): PaxPrice[] {
  const types = new Set(prices.map((p) => p.paxType));
  if (types.size !== prices.length) throw new SupplierPayloadError(`${path}: a passenger type is priced twice`);
  return [...prices].sort((a, b) => (a.paxType < b.paxType ? -1 : a.paxType > b.paxType ? 1 : 0));
}
