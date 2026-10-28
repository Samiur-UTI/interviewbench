import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { itineraryKey, parseCaravel, parseKeystone, parsePayload, parseTessera, SupplierPayloadError } from "../src/index.ts";
import type { Itinerary } from "../src/index.ts";

// The three fixtures answer the same search: DXB -> SIN on 1 Dec, SIN -> DXB on 8 Dec, 2 adults + 1 child.
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const caravel = (): Itinerary[] => parseCaravel(fixture("caravel-dxb-sin.json"), "caravel");
const tessera = (): Itinerary[] => parseTessera(fixture("tessera-dxb-sin.json"), "tessera");
const keystone = (): Itinerary[] => parseKeystone(fixture("keystone-dxb-sin.json"), "keystone");

test("caravel offers are normalised", () => {
  const [first, , third] = caravel();
  assert.equal(first.id, "caravel:1");
  assert.equal(first.validatingCarrier, "XB");
  assert.equal(first.brand, "SAVER");
  assert.equal(first.seatsAvailable, 4);
  assert.deepEqual(first.journeys[0].segments[1], {
    marketingCarrier: "XB",
    flightNumber: "XB4417",
    operatingCarrier: "ZK",
    origin: "DEL",
    destination: "SIN",
    departureUtc: "2026-12-01T15:45:00.000Z", // 21:15 in Delhi (+05:30)
    arrivalUtc: "2026-12-01T21:25:00.000Z",
    bookingCode: "K",
    cabin: "ECONOMY",
    fareBasis: "KLOWXW",
  });
  assert.equal(first.journeys[0].durationMinutes, 655);
  assert.equal(first.durationMinutes, 655 + 445);
  assert.equal(first.stops, 1);
  assert.deepEqual(first.prices, [
    { paxType: "ADT", count: 2, unitTotalCents: 50835 },
    { paxType: "CHD", count: 1, unitTotalCents: 39010 },
  ]);
  // Offer 3 carries a 3.50 ticketing fee on top of fare.total.
  assert.deepEqual(
    [third.totalPrice, third.baseCents, third.taxesCents, third.feesCents],
    [137180, 109450, 27380, 350],
  );
});

test("caravel booking classes follow segRef, not list order", () => {
  // Offer 2 lists its segment fares in the order 3, 1, 2: business out, economy back.
  const second = caravel()[1];
  assert.deepEqual(
    second.journeys.map((j) => j.segments.map((s) => `${s.flightNumber}/${s.bookingCode}/${s.cabin}`)),
    [["XB581/J/BUSINESS", "XB4417/J/BUSINESS"], ["ZK9/Q/ECONOMY"]],
  );
});

test("tessera itineraries are normalised, one offer per quote", () => {
  const its = tessera();
  assert.deepEqual(
    its.map((it) => [it.id, it.brand, it.totalPrice, it.seatsAvailable]),
    [
      ["tessera:1.1", "SAVER", 140250, 4],
      ["tessera:1.2", "FLEX", 388360, 2],
      ["tessera:2.1", "SAVER", 136830, 7],
    ],
  );
  const zk9 = its[0].journeys[1].segments[0];
  assert.equal(zk9.departureUtc, "2026-12-07T17:35:00.000Z"); // 01:35 on 8 Dec in Singapore
  assert.equal(zk9.arrivalUtc, "2026-12-08T01:00:00.000Z");
  assert.equal(its[0].journeys[0].segments[1].arrivalUtc, "2026-12-01T21:25:00.000Z"); // next local day
  // Itinerary 2 has one fare component over all three flights.
  assert.deepEqual(its[2].journeys.flatMap((j) => j.segments.map((s) => `${s.bookingCode}/${s.fareBasis}`)), ["L/LSTPXW", "L/LSTPXW", "Q/LSTPXW"]);
  assert.deepEqual(its[0].prices, [
    { paxType: "ADT", count: 2, unitTotalCents: 50620 },
    { paxType: "CHD", count: 1, unitTotalCents: 39010 },
  ]);
});

test("keystone price points expand to every option combination", () => {
  const its = keystone();
  assert.deepEqual(
    its.map((it) => [it.id, it.totalPrice, it.seatsAvailable]),
    [
      ["keystone:pP1==|oA1==|oA3==", 140680, 4],
      ["keystone:pP1==|oA2==|oA3==", 140680, 5],
      ["keystone:pP2==|oC1==|oC2==", 388360, 2],
    ],
  );
  assert.equal(its[0].journeys[0].segments[1].operatingCarrier, "ZK");
  assert.deepEqual(its[2].prices, [
    { paxType: "ADT", count: 2, unitTotalCents: 140845 },
    { paxType: "CHD", count: 1, unitTotalCents: 106670 },
  ]);
});

test("the three formats describe the same flights the same way", () => {
  const [c] = caravel();
  const [t] = tessera();
  const [k] = keystone();
  assert.deepEqual(t.journeys, c.journeys);
  assert.deepEqual(k.journeys, c.journeys);
  assert.equal(itineraryKey(t), itineraryKey(c));
});

test("parsePayload picks the parser by format", () => {
  assert.deepEqual(parsePayload("keystone", fixture("keystone-dxb-sin.json"), "ks"), parseKeystone(fixture("keystone-dxb-sin.json"), "ks"));
  assert.throws(() => parsePayload("skyhigh" as never, "{}", "x"), SupplierPayloadError);
});

test("unreadable payloads are supplier errors", () => {
  assert.throws(() => parseCaravel("{not json", "caravel"), SupplierPayloadError);
  const doc = JSON.parse(fixture("caravel-dxb-sin.json"));
  doc.meta.currency = "EUR";
  assert.throws(() => parseCaravel(JSON.stringify(doc), "caravel"), SupplierPayloadError);
  const ts = JSON.parse(fixture("tessera-dxb-sin.json"));
  ts.shopResponse.legTable[0].schedules[0].ref = 999;
  assert.throws(() => parseTessera(JSON.stringify(ts), "tessera"), SupplierPayloadError);
  const ks = JSON.parse(fixture("keystone-dxb-sin.json"));
  delete ks.searchRsp.segmentIndex;
  assert.throws(() => parseKeystone(JSON.stringify(ks), "keystone"), SupplierPayloadError);
});

test("an offer repeated word for word is kept once; two offers under one reference are an error", () => {
  const doc = JSON.parse(fixture("caravel-dxb-sin.json"));
  doc.offers.push(doc.offers[0]);
  assert.deepEqual(parsePayload("caravel", JSON.stringify(doc), "caravel").map((it) => it.id), ["caravel:1", "caravel:2", "caravel:3"]);
  doc.offers[3] = { ...doc.offers[1], offerId: "1" };
  assert.throws(() => parsePayload("caravel", JSON.stringify(doc), "caravel"), SupplierPayloadError);
});
