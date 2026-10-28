import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseAeroLink, SupplierPayloadError, toMinorUnits } from "../src/index.ts";

test("toMinorUnits is exact for amounts that floats get wrong", () => {
  // Math.floor(parseFloat(x) * 100) was 1 cent short for each of these.
  for (const [input, cents] of [
    ["578.68", 57868],
    ["36.41", 3641],
    ["17.99", 1799],
    ["0.29", 29],
    ["19.99", 1999],
    ["1024.09", 102409],
  ] as const) {
    assert.equal(toMinorUnits(input), cents, input);
  }
  assert.equal(toMinorUnits("35"), 3500);
  assert.equal(toMinorUnits("0.5"), 50);
});

test("every 2-decimal amount up to $100,000 converts exactly", () => {
  for (let cents = 0; cents <= 10_000_000; cents += 7) {
    const text = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    if (toMinorUnits(text) !== cents) assert.fail(`${text} -> ${toMinorUnits(text)}`);
  }
});

test("toMinorUnits rejects anything but plain digits with up to 2 decimals", () => {
  for (const bad of ["12.345", "1e3", "", "-5.00", "12,50", " 1.00", "1.", ".5", "NaN", "Infinity"]) {
    assert.throws(() => toMinorUnits(bad), Error, JSON.stringify(bad));
  }
});

test("the README example totals 66808 cents", () => {
  const raw = readFileSync(new URL("./fixtures/aerolink-lhr-dxb.json", import.meta.url), "utf8");
  const doc = JSON.parse(raw);
  doc.offers[0].price = {
    filedCurrency: "GBP",
    base: "578.68",
    taxes: [
      { code: "YQ", amount: "36.41" },
      { code: "AE", amount: "17.99" },
      { code: "YR", amount: "35.00" },
    ],
  };
  assert.equal(parseAeroLink(JSON.stringify(doc), "aerolink")[0].totalPrice, 66808);
});

test("a malformed amount makes the whole AeroLink response a supplier error", () => {
  const doc = JSON.parse(readFileSync(new URL("./fixtures/aerolink-lhr-dxb.json", import.meta.url), "utf8"));
  doc.offers[1].price.taxes[0].amount = "20.505";
  assert.throws(() => parseAeroLink(JSON.stringify(doc), "aerolink"), SupplierPayloadError);
});
