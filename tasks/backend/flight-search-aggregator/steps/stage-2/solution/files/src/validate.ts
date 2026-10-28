import { ValidationError } from "./errors.ts";
import type { SearchRequest } from "./types.ts";

const AIRPORT = /^[A-Z]{3}$/;
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
  if (!Number.isInteger(req.passengers) || req.passengers < 1 || req.passengers > MAX_PASSENGERS) {
    throw new ValidationError(`passengers must be an integer from 1 to ${MAX_PASSENGERS}`);
  }
}

export const MAX_TIMEOUT_MS = 30_000;

/** Deadlines are whole milliseconds from 1 to 30000; returns the value when valid. */
export function validateTimeoutMs(value: unknown, name = "timeoutMs"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new ValidationError(`${name} must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return value;
}
