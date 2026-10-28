import { ValidationError } from "./errors.ts";
import type { SearchRequest, SortPreference } from "./types.ts";

const AIRPORT = /^[A-Z]{3}$/;
const CARRIER = /^[A-Z]{2}$/;
const SORTS: readonly SortPreference[] = ["cheapest", "fastest", "fewest_stops", "preferred_airline"];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_PASSENGERS = 9;
const LEGS: Record<string, [min: number, max: number]> = {
  oneway: [1, 1],
  return: [2, 2],
  multicity: [2, 6],
};

function isValidDate(value: unknown): boolean {
  const m = typeof value === "string" ? DATE.exec(value) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Throws ValidationError unless `req` is a search we can send to suppliers. */
export function validateSearchRequest(req: SearchRequest): void {
  if (typeof req !== "object" || req === null) throw new ValidationError("request must be an object");
  const range = LEGS[req.tripType as string];
  if (!range) throw new ValidationError("tripType must be oneway, return or multicity");
  if (!Array.isArray(req.legs) || req.legs.length < range[0] || req.legs.length > range[1]) {
    throw new ValidationError(`a ${req.tripType} search needs ${range[0]}-${range[1]} legs`);
  }
  req.legs.forEach((leg, i) => {
    if (typeof leg !== "object" || leg === null) throw new ValidationError(`legs[${i}] must be an object`);
    if (!AIRPORT.test(String(leg.origin)) || !AIRPORT.test(String(leg.destination))) {
      throw new ValidationError(`legs[${i}]: airports must be 3-letter IATA codes`);
    }
    if (leg.origin === leg.destination) throw new ValidationError(`legs[${i}]: origin equals destination`);
    if (!isValidDate(leg.date)) throw new ValidationError(`legs[${i}]: date must be YYYY-MM-DD`);
  });
  const pax = req.passengers;
  if (typeof pax !== "object" || pax === null) throw new ValidationError("passengers must be an object");
  if (!Number.isInteger(pax.adults) || pax.adults < 1) throw new ValidationError("passengers.adults must be an integer >= 1");
  if (!Number.isInteger(pax.children) || pax.children < 0) throw new ValidationError("passengers.children must be an integer >= 0");
  if (pax.adults + pax.children > MAX_PASSENGERS) {
    throw new ValidationError(`at most ${MAX_PASSENGERS} passengers per search`);
  }
  if (req.preferredCarrier !== undefined && !CARRIER.test(String(req.preferredCarrier))) {
    throw new ValidationError("preferredCarrier must be a 2-letter airline code");
  }
  if (req.sort !== undefined && !SORTS.includes(req.sort)) {
    throw new ValidationError(`sort must be one of ${SORTS.join(", ")}`);
  }
}
