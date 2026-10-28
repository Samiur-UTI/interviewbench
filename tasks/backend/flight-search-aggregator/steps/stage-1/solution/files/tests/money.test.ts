import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseAeroLink, SupplierPayloadError, toMinorUnits } from "../src/index.ts";

test("toMinorUnits is exact for amounts that floats get wrong", () => {
  // Math.floor(parseFloat(x) * 100) was 1 poisha short for each of these.
  for (const [input, poisha] of [
    ["41111.13", 4111113],
    ["2162.99", 216299],
    ["4538.69", 453869],
    ["0.29", 29],
    ["19.99", 1999],
    ["1024.09", 102409],
  ] as const) {
    assert.equal(toMinorUnits(input), poisha, input);
  }
  assert.equal(toMinorUnits("3105"), 310500);
  assert.equal(toMinorUnits("0.5"), 50);
});

test("every 2-decimal amount up to 100,000 BDT converts exactly", () => {
  for (let poisha = 0; poisha <= 10_000_000; poisha += 7) {
    const text = `${Math.floor(poisha / 100)}.${String(poisha % 100).padStart(2, "0")}`;
    if (toMinorUnits(text) !== poisha) assert.fail(`${text} -> ${toMinorUnits(text)}`);
  }
});

test("toMinorUnits rejects anything but plain digits with up to 2 decimals", () => {
  for (const bad of ["12.345", "1e3", "", "-5.00", "12,50", " 1.00", "1.", ".5", "NaN", "Infinity"]) {
    assert.throws(() => toMinorUnits(bad), Error, JSON.stringify(bad));
  }
});

test("the README example totals 5091781 poisha", () => {
  const raw = readFileSync(new URL("./fixtures/aerolink-dac-dxb.json", import.meta.url), "utf8");
  const doc = JSON.parse(raw);
  doc.offers[0].price = {
    filedCurrency: "USD",
    base: "41111.13",
    taxes: [
      { code: "YQ", amount: "2162.99" },
      { code: "AE", amount: "4538.69" },
      { code: "BD", amount: "3105.00" },
    ],
  };
  assert.equal(parseAeroLink(JSON.stringify(doc), "aerolink")[0].totalPrice, 5091781);
});

test("a malformed amount makes the whole AeroLink response a supplier error", () => {
  const doc = JSON.parse(readFileSync(new URL("./fixtures/aerolink-dac-dxb.json", import.meta.url), "utf8"));
  doc.offers[1].price.taxes[0].amount = "2050.105";
  assert.throws(() => parseAeroLink(JSON.stringify(doc), "aerolink"), SupplierPayloadError);
});
