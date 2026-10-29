import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseCaravel, parseKeystone, SupplierPayloadError, toMinorUnits } from "../src/index.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("toMinorUnits is exact for amounts that floats get wrong", () => {
  // Math.floor(parseFloat(x) * 100) was 1 cent short for each of these.
  for (const [input, cents] of [
    ["1037.11", 103711],
    ["0.29", 29],
    ["4.35", 435],
    ["1.13", 113],
    ["300.15", 30015],
  ] as const) {
    assert.equal(toMinorUnits(input), cents, input);
  }
  assert.equal(toMinorUnits("0.00"), 0);
});

test("every 2-decimal amount up to $100,000 converts exactly", () => {
  for (let cents = 0; cents <= 10_000_000; cents += 7) {
    const text = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    if (toMinorUnits(text) !== cents) assert.fail(`${text} -> ${toMinorUnits(text)}`);
  }
});

test("toMinorUnits rejects anything but digits with exactly 2 decimals", () => {
  for (const bad of ["12.345", "12.5", "12", "1e3", "", "-5.00", "1,037.11", " 1.00", "01.00", ".50", "NaN"]) {
    assert.throws(() => toMinorUnits(bad), SupplierPayloadError, JSON.stringify(bad));
  }
});

test("a Caravel grandTotal of 1037.11 is 103711 cents", () => {
  const doc = fixture("caravel-dxb-sin.json");
  const offer = doc.offers[2];
  offer.fare = { ...offer.fare, total: "1032.47", base: "300.15", fees: [{ amount: "0.29", kind: "SUPPLIER" }, { amount: "4.35", kind: "TICKETING" }], grandTotal: "1037.11" };
  for (const t of offer.travellerPricing) t.price.total = t.paxType === "ADULT" ? "345.29" : "341.89";
  const it = parseCaravel(JSON.stringify(doc), "caravel")[2];
  assert.deepEqual([it.totalPrice, it.feesCents], [103711, 464]);
});

test("Caravel amounts that don't add up are a supplier error", () => {
  const doc = fixture("caravel-dxb-sin.json");
  doc.offers[2].fare.grandTotal = "1371.81"; // total 1368.30 + fee 3.50 = 1371.80
  assert.throws(() => parseCaravel(JSON.stringify(doc), "caravel"), SupplierPayloadError);
});

test("Keystone amounts must be USD and add up", () => {
  for (const [field, value] of [
    ["totalPrice", "EUR1406.80"],
    ["totalPrice", "USD1406.81"],
    ["basePrice", "1133.00"],
  ]) {
    const doc = fixture("keystone-dxb-sin.json");
    doc.searchRsp.pricePoints.pricePoint[0][field] = value;
    assert.throws(() => parseKeystone(JSON.stringify(doc), "keystone"), SupplierPayloadError, `${field} ${value}`);
  }
  const odd = fixture("keystone-dxb-sin.json");
  Object.assign(odd.searchRsp.pricePoints.pricePoint[0], { totalPrice: "USD1406.81", taxes: "USD273.81" });
  odd.searchRsp.pricePoints.pricePoint[0].pricingInfo[0].totalPrice = "USD1016.71"; // 2 adults: half a cent each
  assert.throws(() => parseKeystone(JSON.stringify(odd), "keystone"), SupplierPayloadError);
});
