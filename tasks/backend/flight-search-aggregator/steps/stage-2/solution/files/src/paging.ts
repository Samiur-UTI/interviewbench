// Sort orders, page sizes and cursors for paging through a stored search (README, rules 5 and 7).
import { ValidationError } from "./errors.ts";
import type { Itinerary, SortPreference } from "./types.ts";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

const SORTS: readonly SortPreference[] = ["cheapest", "fastest", "fewest_stops", "preferred_airline"];

/** What a sort compares, in order, before the offer id. Every order ends in the offer id. */
export type SortKeys = [number, number];

/** A position in one sort order: the sort keys and the id of an offer (which may not exist). */
export interface Position {
  keys: SortKeys;
  offerId: string;
}

/** The values a sort compares. `prefRank` is 0 for the search's preferred carrier, else 1. */
export interface Sortable {
  id: string;
  totalPrice: number;
  durationMinutes: number;
  stops: number;
  prefRank: number;
}

export function sortKeys(offer: Sortable, sort: SortPreference): SortKeys {
  switch (sort) {
    case "cheapest":
      return [offer.totalPrice, offer.durationMinutes];
    case "fastest":
      return [offer.durationMinutes, offer.totalPrice];
    case "fewest_stops":
      return [offer.stops, offer.totalPrice];
    case "preferred_airline":
      return [offer.prefRank, offer.totalPrice];
  }
}

/** Orders positions by their keys, then by offer id compared as a binary string. */
export function comparePositions(a: Position, b: Position): number {
  return a.keys[0] - b.keys[0] || a.keys[1] - b.keys[1] || (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0);
}

export function prefRank(it: Itinerary, preferredCarrier: string | undefined | null): number {
  return preferredCarrier && it.validatingCarrier === preferredCarrier ? 0 : 1;
}

export function validateSort(value: unknown): SortPreference {
  if (!SORTS.includes(value as SortPreference)) {
    throw new ValidationError(`sort must be one of ${SORTS.join(", ")}`);
  }
  return value as SortPreference;
}

export function validateLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_PAGE_SIZE) {
    throw new ValidationError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return value as number;
}

interface CursorJson {
  v: 1;
  s: string; // search id
  o: SortPreference;
  k: [number, number, string]; // sort keys, then offer id
}

/** base64url (no padding) of `{"v":1,"s":searchId,"o":sort,"k":[key1,key2,offerId]}`. */
export function encodeCursor(searchId: string, sort: SortPreference, position: Position): string {
  const json: CursorJson = { v: 1, s: searchId, o: sort, k: [...position.keys, position.offerId] };
  return Buffer.from(JSON.stringify(json)).toString("base64url");
}

/**
 * Decodes a cursor for paging `searchId` in `sort` order. A well-formed cursor is a position:
 * the offer it names doesn't have to exist. Anything else, including a cursor issued for another
 * search or another sort, is a ValidationError.
 */
export function decodeCursor(cursor: unknown, searchId: string, sort: SortPreference): Position {
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ValidationError("malformed cursor");
  const bytes = Buffer.from(cursor, "base64url");
  // Buffer.from ignores leftover bits, so other strings decode to the same bytes: only the exact
  // encoding we issued is a cursor.
  if (bytes.toString("base64url") !== cursor) throw new ValidationError("malformed cursor");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ValidationError("malformed cursor");
  }
  const c = json as Partial<CursorJson> | null;
  const k = c?.k;
  if (
    typeof c !== "object" ||
    c === null ||
    c.v !== 1 ||
    typeof c.s !== "string" ||
    typeof c.o !== "string" ||
    !Array.isArray(k) ||
    k.length !== 3 ||
    !Number.isSafeInteger(k[0]) ||
    !Number.isSafeInteger(k[1]) ||
    typeof k[2] !== "string"
  ) {
    throw new ValidationError("malformed cursor");
  }
  if (c.s !== searchId) throw new ValidationError("cursor belongs to another search");
  if (c.o !== sort) throw new ValidationError(`cursor belongs to the ${c.o} order, not ${sort}`);
  return { keys: [k[0], k[1]], offerId: k[2] };
}
