// Stage 1 hidden tests: different trips are never merged, AeroLink totals are exact to the cent,
// and malformed amounts are rejected. Expected totals come from exactCents (BigInt), never floats.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadApp } from "./helpers/app.ts";
import { resolving } from "./helpers/fakes.ts";
import { ANY_REQUEST, aeroLinkRaw, exactCents, segment, skyMeshRaw, toItineraries } from "./helpers/payloads.ts";
import type { Amounts, GenOffer, GenSegment } from "./helpers/payloads.ts";

const services: { close?: () => Promise<void> }[] = [];
after(async () => {
  for (const s of services) if (typeof s.close === "function") await s.close();
});

async function search(clients: unknown[], passengers = 1) {
  const app = await loadApp();
  const svc = new app.FlightSearchService(clients);
  services.push(svc);
  return (await svc.search({ ...ANY_REQUEST, passengers })) as { id: string; totalPrice: number }[];
}

// XB581/XB582 LHR-DXB return, as in the README.
const outbound = (cls: string, day = "01"): GenSegment =>
  segment("XB581", "LHR", "DXB", `2026-12-${day}T15:40:00Z`, `2026-12-${day}T21:05:00Z`, cls);
const inbound = (cls: string): GenSegment => segment("XB582", "DXB", "LHR", "2026-12-09T23:15:00Z", "2026-12-10T04:20:00Z", cls);
const trip = (cls: string): GenSegment[][] => [[outbound(cls)], [inbound(cls)]];

/** Whole-dollar amounts, so these offers don't depend on the money fix. */
const whole = (totalMinor: number): Amounts => ({
  base: `${(totalMinor - 3_500) / 100}.00`,
  taxes: [{ code: "YR", amount: "35.00" }],
});
const offer = (ref: string, journeys: GenSegment[][], totalMinor: number, seats = 4): GenOffer => ({
  ref,
  journeys,
  seats,
  totalMinor,
  amounts: whole(totalMinor),
});

test("s1 business fare survives next to economy on the same flights", async () => {
  const raw = aeroLinkRaw([offer("AL-1", trip("K"), 50_900), offer("AL-2", trip("J"), 184_500)]);
  const ids = (await search([resolving("aerolink", "aerolink", raw)])).map((it) => it.id).sort();
  assert.deepEqual(ids, ["aerolink:AL-1", "aerolink:AL-2"]);
});

test("s1 same trip from two suppliers is merged, cheaper kept", async () => {
  for (const [alPrice, smPrice, winner] of [
    [50_900, 50_500, "skymesh:SM-1"],
    [50_000, 50_500, "aerolink:AL-1"],
  ] as const) {
    const results = await search([
      resolving("aerolink", "aerolink", aeroLinkRaw([offer("AL-1", trip("K"), alPrice)])),
      resolving("skymesh", "skymesh", skyMeshRaw([offer("SM-1", trip("K"), smPrice)])),
    ]);
    assert.deepEqual(results.map((it) => it.id), [winner]);
    assert.equal(results[0].totalPrice, Math.min(alPrice, smPrice));
  }
});

test("s1 price tie keeps the preferred supplier", async () => {
  const al = resolving("aerolink", "aerolink", aeroLinkRaw([offer("AL-1", trip("K"), 50_000)]));
  const sm = resolving("skymesh", "skymesh", skyMeshRaw([offer("SM-1", trip("K"), 50_000)]));
  assert.deepEqual((await search([al, sm])).map((it) => it.id), ["aerolink:AL-1"]);
  assert.deepEqual((await search([sm, al])).map((it) => it.id), ["skymesh:SM-1"]);
});

test("s1 same flight numbers on different dates are different trips", async () => {
  const app = await loadApp();
  const [a] = toItineraries([offer("AL-1", [[outbound("K", "01")]], 40_000)], "aerolink");
  const [b] = toItineraries([offer("SM-1", [[outbound("K", "02")]], 39_000)], "skymesh");
  const merged = app.mergeItineraries([[a], [b]], ["aerolink", "skymesh"]);
  assert.deepEqual(merged.map((it: { id: string }) => it.id), ["skymesh:SM-1", "aerolink:AL-1"]);
});

test("s1 journey split matters", async () => {
  const app = await loadApp();
  const s1 = segment("ZQ207", "LHR", "DOH", "2026-12-01T02:00:00Z", "2026-12-01T07:30:00Z", "K");
  const s2 = segment("ZQ880", "DOH", "DXB", "2026-12-04T09:00:00Z", "2026-12-04T10:15:00Z", "K");
  const [oneJourney] = toItineraries([offer("AL-1", [[s1, s2]], 40_000)], "aerolink");
  const [twoJourneys] = toItineraries([offer("SM-1", [[s1], [s2]], 39_000)], "skymesh");
  const merged = app.mergeItineraries([[oneJourney], [twoJourneys]], ["aerolink", "skymesh"]);
  assert.equal(merged.length, 2);
});

// Every amount below loses a cent under Math.floor(parseFloat(x) * 100) (checked with node).
const TRAPS = ["578.68", "1099.09", "36.41", "64.74", "17.99", "40.87", "64.32", "74.99", "139.98", "140.95", "19.99", "1024.09"];

test("s1 aerolink totals are exact to the cent", async () => {
  const app = await loadApp();
  const amounts: Record<string, Amounts> = {
    readme: { base: "578.68", taxes: [{ code: "YQ", amount: "36.41" }, { code: "AE", amount: "17.99" }, { code: "YR", amount: "35.00" }] },
    big: { base: "1099.09", taxes: [{ code: "YQ", amount: "64.74" }, { code: "AE", amount: "40.87" }, { code: "YR", amount: "35.00" }] },
    small: { base: "578.68", taxes: ["64.32", "74.99", "139.98", "140.95", "19.99", "1024.09"].map((amount, i) => ({ code: `T${i}`, amount })) },
    thirty: { base: "1024.09", taxes: Array.from({ length: 30 }, (_, i) => ({ code: `X${i}`, amount: TRAPS[i % TRAPS.length] })) },
    plain: { base: "384.50", taxes: [{ code: "YR", amount: "35.00" }] },
  };
  const offers: GenOffer[] = Object.entries(amounts).map(([ref, a], i) => ({
    ref,
    journeys: [[outbound("K", `0${i + 1}`)]],
    seats: 4,
    totalMinor: 0,
    amounts: a,
  }));
  const parsed: { supplierRef: string; totalPrice: number }[] = app.parseAeroLink(aeroLinkRaw(offers), "aerolink");
  const got = Object.fromEntries(parsed.map((it) => [it.supplierRef, it.totalPrice]));
  const expected = Object.fromEntries(
    Object.entries(amounts).map(([ref, a]) => [ref, exactCents(a.base) + a.taxes.reduce((n, t) => n + exactCents(t.amount), 0)]),
  );
  assert.equal(expected.readme, 66_808);
  assert.deepEqual(got, expected);
});

test("s1 toMinorUnits converts exactly", async () => {
  const app = await loadApp();
  const table: [string, number][] = [
    ["0", 0],
    ["0.5", 50],
    ["0.29", 29],
    ["19.99", 1999],
    ["1024.09", 102409],
    ["578.68", 57868],
    ["1099.09", 109909],
    ["123456789.01", 12345678901],
  ];
  for (const [input, cents] of table) assert.equal(app.toMinorUnits(input), cents, `toMinorUnits(${JSON.stringify(input)})`);
});

test("s1 malformed amounts are rejected", async () => {
  const app = await loadApp();
  for (const bad of ["12.345", "1e3", "", "-5.00", "12,50", " 1.00"]) {
    const raw = aeroLinkRaw([
      { ref: "AL-1", journeys: trip("K"), seats: 4, totalMinor: 0, amounts: { base: "384.50", taxes: [{ code: "AE", amount: bad }, { code: "YR", amount: "35.00" }] } },
    ]);
    assert.throws(() => app.parseAeroLink(raw, "aerolink"), app.SupplierPayloadError, `amount ${JSON.stringify(bad)}`);
    assert.throws(() => app.toMinorUnits(bad), Error, `toMinorUnits(${JSON.stringify(bad)})`);
  }
});

test("s1 results ordered by price, duration, preference, supplierRef", async () => {
  const app = await loadApp();
  // Different flights, so the expected order holds whatever the dedup key looks like.
  const make = (ref: string, supplier: string, day: string, totalPrice: number, durationMinutes: number) => ({
    ...toItineraries([offer(ref, [[segment(`QV40${day}`, "LHR", "SIN", `2026-12-${day}T03:00:00Z`, `2026-12-${day}T08:00:00Z`, "K")]], totalPrice)], supplier)[0],
    totalPrice,
    durationMinutes,
  });
  const lists = [
    [make("B", "aerolink", "01", 50_000, 600), make("A", "aerolink", "02", 50_000, 600), make("E", "aerolink", "05", 49_000, 900)],
    [make("C", "skymesh", "03", 50_000, 600), make("D", "skymesh", "04", 50_000, 500)],
  ];
  const merged = app.mergeItineraries(lists, ["aerolink", "skymesh"]);
  assert.deepEqual(
    merged.map((it: { id: string }) => it.id),
    ["aerolink:E", "skymesh:D", "aerolink:A", "aerolink:B", "skymesh:C"],
  );
});

test("s1 offers without enough seats are hidden", async () => {
  const raw = aeroLinkRaw([offer("AL-1", trip("K"), 50_000, 2), offer("AL-2", trip("M"), 52_000, 3)]);
  const ids = (await search([resolving("aerolink", "aerolink", raw)], 3)).map((it) => it.id);
  assert.deepEqual(ids, ["aerolink:AL-2"]);
});

test("s1 a sold-out cheap duplicate does not hide an available one", async () => {
  const results = await search(
    [
      resolving("aerolink", "aerolink", aeroLinkRaw([offer("AL-1", trip("K"), 49_000, 1)])),
      resolving("skymesh", "skymesh", skyMeshRaw([offer("SM-1", trip("K"), 51_000, 5)])),
    ],
    2,
  );
  assert.deepEqual(results.map((it) => it.id), ["skymesh:SM-1"]);
});
