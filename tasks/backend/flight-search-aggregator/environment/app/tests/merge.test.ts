import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mergeItineraries, parseCaravel, parseKeystone, parseTessera } from "../src/index.ts";
import type { Itinerary } from "../src/index.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const caravel = (): Itinerary[] => parseCaravel(fixture("caravel-dxb-sin.json"), "caravel");
const tessera = (): Itinerary[] => parseTessera(fixture("tessera-dxb-sin.json"), "tessera");
const keystone = (): Itinerary[] => parseKeystone(fixture("keystone-dxb-sin.json"), "keystone");
const PREFERENCE = ["caravel", "tessera", "keystone"];

test("the same trip from several suppliers is shown once, at the cheapest price", () => {
  const merged = mergeItineraries([caravel(), tessera(), keystone()], PREFERENCE);
  const xb581k = merged.filter((it) => it.journeys[0].segments[0].flightNumber === "XB581" && it.journeys[0].segments[0].bookingCode === "K");
  assert.deepEqual(xb581k.map((it) => [it.id, it.totalPrice]), [["tessera:1.1", 140250]]);
});

test("business, and K vs L on the same flights, are different products", () => {
  const ids = mergeItineraries([caravel(), tessera(), keystone()], PREFERENCE).map((it) => it.id);
  assert.ok(ids.includes("caravel:2"), "business copy kept"); // ties with tessera:1.2 and keystone; caravel is preferred
  assert.ok(ids.includes("tessera:2.1"), "XB583 in L");
  assert.ok(ids.includes("keystone:pP1==|oA2==|oA3=="), "XB583 in K");
});

test("results are sorted cheapest first, then shortest, then by id", () => {
  const merged = mergeItineraries([caravel(), tessera(), keystone()], PREFERENCE);
  assert.deepEqual(
    merged.map((it) => it.id),
    ["tessera:2.1", "tessera:1.1", "keystone:pP1==|oA2==|oA3==", "caravel:2"],
  );
});

test("on a price tie the preferred supplier wins", () => {
  const [c] = caravel();
  const [k] = keystone(); // same trip and price as caravel:1
  assert.equal(mergeItineraries([[c], [k]], ["caravel", "keystone"])[0].id, "caravel:1");
  assert.equal(mergeItineraries([[c], [k]], ["keystone", "caravel"])[0].id, "keystone:pP1==|oA1==|oA3==");
});
