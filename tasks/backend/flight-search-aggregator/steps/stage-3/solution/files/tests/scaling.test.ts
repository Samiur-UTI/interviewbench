import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compareItineraries, FlightSearchService, itineraryKey, mergeItineraries, parseAeroLink, ValidationError } from "../src/index.ts";
import type { Itinerary } from "../src/index.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const PREFERENCE = ["aerolink", "skymesh", "other"];

/** The old O(n^2) merge, kept here as the oracle for "results are unchanged". */
function slowMerge(lists: Itinerary[][], preference: string[]): Itinerary[] {
  const rank = (s: string) => (preference.indexOf(s) === -1 ? preference.length : preference.indexOf(s));
  const keys: string[] = [];
  const best: Itinerary[] = [];
  for (const it of lists.flat()) {
    const i = keys.indexOf(itineraryKey(it));
    if (i === -1) {
      keys.push(itineraryKey(it));
      best.push(it);
    } else if (it.totalPrice < best[i].totalPrice || (it.totalPrice === best[i].totalPrice && rank(it.supplier) < rank(best[i].supplier))) {
      best[i] = it;
    }
  }
  return best.sort((a, b) => compareItineraries(a, b, rank));
}

/** Variations of the fixture trip: many duplicates and many price/duration ties. */
function market(n: number, seed: number): Itinerary[][] {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const base = parseAeroLink(fixture("aerolink-lhr-dxb.json"), "aerolink")[0];
  const lists: Itinerary[][] = [[], [], []];
  for (let i = 0; i < n; i++) {
    const trip = Math.floor(rand() * (n / 3));
    const supplier = Math.floor(rand() * 3);
    const day = new Date(Date.UTC(2026, 11, 1) + (trip % 300) * 86_400_000).toISOString().slice(0, 10);
    lists[supplier].push({
      ...base,
      id: `${PREFERENCE[supplier]}:R${i}`,
      supplier: PREFERENCE[supplier],
      supplierRef: `R${i}`,
      totalPrice: 40_000 + Math.floor(rand() * 4) * 10 + supplier,
      durationMinutes: 600 + Math.floor(rand() * 3) * 30,
      journeys: [
        {
          segments: [
            { ...base.journeys[0].segments[0], flightNumber: `XB${100 + Math.floor(trip / 300)}`, departureUtc: `${day}T15:40:00.000Z` },
          ],
        },
      ],
    });
  }
  return lists;
}

test("the fast merge gives exactly the old results, order included", () => {
  for (const seed of [1, 2, 3]) {
    const lists = market(3000, seed);
    assert.deepEqual(mergeItineraries(lists, PREFERENCE), slowMerge(lists, PREFERENCE));
  }
});

test("merging 150,000 offers takes well under a second or two", () => {
  const lists = market(150_000, 4);
  const start = performance.now();
  mergeItineraries(lists, PREFERENCE);
  assert.ok(performance.now() - start < 1500);
});

test("parserThreads must be a positive integer", () => {
  const client = { name: "a", format: "aerolink" as const, search: async () => fixture("aerolink-lhr-dxb.json") };
  for (const parserThreads of [0, -1, 1.5]) {
    assert.throws(() => new FlightSearchService([client], { parserThreads }), ValidationError);
  }
});
