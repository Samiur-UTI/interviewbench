import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseAeroLink, parsePayload, parseSkyMesh, SupplierPayloadError } from "../src/index.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("aerolink offers are normalised", () => {
  const its = parseAeroLink(fixture("aerolink-lhr-dxb.json"), "aerolink");
  assert.equal(its.length, 2);
  const [first] = its;
  assert.equal(first.id, "aerolink:AL-000123");
  assert.equal(first.supplierRef, "AL-000123");
  assert.equal(first.seatsAvailable, 4);
  assert.equal(first.totalPrice, 38450 + 1980 + 3820 + 3500);
  assert.equal(first.durationMinutes, 325 + 305);
  assert.deepEqual(first.journeys[0].segments[0], {
    carrier: "XB",
    flightNumber: "XB581",
    origin: "LHR",
    destination: "DXB",
    departureUtc: "2026-12-01T15:40:00.000Z",
    arrivalUtc: "2026-12-01T21:05:00.000Z",
    bookingClass: "K",
  });
});

test("skymesh fares are normalised", () => {
  const its = parseSkyMesh(fixture("skymesh-lhr-dxb.json"), "skymesh");
  assert.equal(its.length, 2);
  assert.equal(its[0].id, "skymesh:SM-55102");
  assert.equal(its[0].totalPrice, 47350);
  assert.equal(its[0].journeys.length, 2);
  assert.equal(its[0].journeys[1].segments[0].departureUtc, "2026-12-09T23:15:00.000Z");
  assert.equal(its[0].durationMinutes, 630);
});

test("both formats describe the same flights the same way", () => {
  const al = parsePayload("aerolink", fixture("aerolink-lhr-dxb.json"), "aerolink")[0];
  const sm = parsePayload("skymesh", fixture("skymesh-lhr-dxb.json"), "skymesh")[0];
  assert.deepEqual(al.journeys, sm.journeys);
});

test("unreadable payloads are supplier errors", () => {
  assert.throws(() => parseAeroLink("{not json", "aerolink"), SupplierPayloadError);
  assert.throws(() => parseSkyMesh(JSON.stringify({ status: "ERR", cur: "USD", fares: [] }), "skymesh"), SupplierPayloadError);
  assert.throws(() => parseAeroLink(JSON.stringify({ currency: "EUR", offers: [] }), "aerolink"), SupplierPayloadError);
});
