import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mergeItineraries, parseAeroLink, parseSkyMesh } from "../src/index.ts";
import type { Itinerary } from "../src/index.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const aerolink = (): Itinerary[] => parseAeroLink(fixture("aerolink-dac-dxb.json"), "aerolink");
const skymesh = (): Itinerary[] => parseSkyMesh(fixture("skymesh-dac-dxb.json"), "skymesh");
const PREFERENCE = ["aerolink", "skymesh"];

test("the same trip from two suppliers is shown once, at the cheaper price", () => {
  const merged = mergeItineraries([aerolink(), skymesh()], PREFERENCE);
  const xb581 = merged.filter((it) => it.journeys[0].segments[0].flightNumber === "XB581");
  assert.equal(xb581.length, 1);
  assert.equal(xb581[0].id, "skymesh:SM-55102");
  assert.equal(xb581[0].totalPrice, 4735000);
});

test("results are sorted cheapest first", () => {
  const merged = mergeItineraries([aerolink(), skymesh()], PREFERENCE);
  assert.deepEqual(
    merged.map((it) => it.id),
    ["skymesh:SM-55102", "aerolink:AL-000124", "skymesh:SM-55103"],
  );
});

test("on a price tie the preferred supplier wins", () => {
  const al = aerolink()[0];
  const sm = { ...skymesh()[0], totalPrice: al.totalPrice };
  assert.equal(mergeItineraries([[al], [sm]], PREFERENCE)[0].id, "aerolink:AL-000123");
  assert.equal(mergeItineraries([[sm], [al]], ["skymesh", "aerolink"])[0].id, "skymesh:SM-55102");
});
