// Stage 1 hidden tests.
// - Tessera dates (tests 1-5): next-day connections, durations, the merge they break. Their data
//   has no amount that a float conversion gets wrong, so they isolate the Tessera bug.
// - Money (tests 6-8): Caravel and Keystone only, so they don't depend on the Tessera fix.
// - Regressions (tests 9-13): what the starter already gets right and a fix must not break.
//
// Expected values come from the reference normaliser on the example search (DXB -> DEL -> SIN on
// 1 Dec, SIN -> DXB on 8 Dec, 2 adults + 1 child; fixtures/*-example.json) and from the seeded
// generator, which computes the itineraries a payload must produce without parsing it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadApp } from "./helpers/app.ts";
import { exactCents, generateSearch, isFloatTrap, tripKey } from "./helpers/payloads.ts";
import type { ExpectedItinerary, SearchRequest } from "./helpers/payloads.ts";

type Format = "caravel" | "tessera" | "keystone";
type It = ExpectedItinerary;

const example = (format: Format): any => JSON.parse(readFileSync(new URL(`./fixtures/${format}-example.json`, import.meta.url), "utf8"));
const raw = (doc: unknown): string => JSON.stringify(doc);

const REQUEST: SearchRequest = {
  tripType: "return",
  legs: [
    { origin: "DXB", destination: "SIN", date: "2026-12-01" },
    { origin: "SIN", destination: "DXB", date: "2026-12-08" },
  ],
  passengers: { adults: 2, children: 1 },
};

const services: { close?: () => Promise<void> }[] = [];
// Later stages store searches in a database file; these tests don't look at it.
const dbDir = mkdtempSync(join(tmpdir(), "ib-s1-"));
after(async () => {
  for (const s of services) if (typeof s.close === "function") await s.close();
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {} // best effort: Windows refuses while a stage-2 service still holds the file open
});

/** A supplier client that answers at once. */
const client = (name: string, format: Format, body: string) => ({ name, format, search: async () => body });

async function search(clients: ReturnType<typeof client>[], req: SearchRequest = REQUEST): Promise<It[]> {
  const app = await loadApp();
  const svc = new app.FlightSearchService(clients, { dbPath: join(dbDir, `search-${services.length}.db`) });
  services.push(svc);
  const result = await svc.searchWithStatus(req);
  assert.ok(result.suppliers.every((s: { status: string }) => s.status === "ok"), JSON.stringify(result.suppliers));
  if (result.itineraries) return result.itineraries;
  // From stage 2 on, results are paged from the database: walk every page, cheapest first.
  const all: It[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await svc.getPage(result.searchId, { sort: "cheapest", limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    all.push(...page.offers);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
}

async function parse(format: Format, body: string, supplier: string = format): Promise<It[]> {
  return (await loadApp()).parsePayload(format, body, supplier);
}

const byId = (its: It[]): Map<string, It> => new Map(its.map((it) => [it.id, it]));

/** README rules 1, 3, 4 and the starter's order: seat filter per supplier, merge, cheapest first. */
function referenceSearch(perSupplier: { name: string; itineraries: It[] }[], seats: number): It[] {
  const rank = new Map(perSupplier.map((s, i) => [s.name, i]));
  const best = new Map<string, It>();
  for (const s of perSupplier) {
    for (const it of s.itineraries) {
      if (it.seatsAvailable < seats) continue;
      const key = tripKey(it);
      const seen = best.get(key);
      if (!seen || it.totalPrice < seen.totalPrice || (it.totalPrice === seen.totalPrice && rank.get(it.supplier)! < rank.get(seen.supplier)!)) {
        best.set(key, it);
      }
    }
  }
  return [...best.values()].sort((a, b) => a.totalPrice - b.totalPrice || a.durationMinutes - b.durationMinutes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- Tessera dates ---------------------------------------------------------------------------

test("s1 tessera next-day connections are dated correctly", async () => {
  const its = byId(await parse("tessera", raw(example("tessera"))));
  for (const id of ["tessera:1.1", "tessera:1.2"]) {
    const [xb581, xb4417] = its.get(id)!.journeys[0].segments;
    assert.equal(xb581.arrivalUtc, "2026-12-01T21:30:00.000Z", `${id} XB581 lands in Delhi at 03:00 on 2 Dec`);
    assert.equal(xb4417.flightNumber, "XB4417");
    assert.equal(xb4417.departureUtc, "2026-12-02T00:45:00.000Z", `${id} XB4417 leaves Delhi at 06:15 on 2 Dec`);
    assert.equal(xb4417.arrivalUtc, "2026-12-02T06:25:00.000Z");
  }
  for (const it of its.values()) {
    for (const j of it.journeys) {
      for (let k = 1; k < j.segments.length; k++) {
        assert.ok(j.segments[k].departureUtc > j.segments[k - 1].arrivalUtc, `${it.id}: ${j.segments[k].flightNumber} leaves before the previous flight lands`);
      }
    }
  }
  // The date is the supplier's, not inferred from the previous arrival: with a stop of more than a
  // day in Delhi, XB4417 leaves on 3 Dec, not on the first day after XB581 lands.
  const doc = example("tessera");
  const leg = doc.shopResponse.legTable.find((l: any) => l.schedules.some((s: any) => s.departureDayOffset === 1));
  leg.schedules.find((s: any) => s.departureDayOffset === 1).departureDayOffset = 2;
  const [, stopover] = byId(await parse("tessera", raw(doc))).get("tessera:1.1")!.journeys[0].segments;
  assert.equal(stopover.departureUtc, "2026-12-03T00:45:00.000Z", "departureDayOffset 2: 06:15 on 3 Dec in Delhi");
});

test("s1 tessera journey durations are exact", async () => {
  const its = await parse("tessera", raw(example("tessera")));
  assert.deepEqual(
    its.map((it) => [it.id, it.journeys.map((j) => j.durationMinutes), it.durationMinutes]),
    [
      ["tessera:1.1", [715, 445], 1160],
      ["tessera:1.2", [715, 445], 1160],
      ["tessera:2.1", [655, 445], 1100],
    ],
  );
  const g = generateSearch({ seed: 101, floatTraps: false });
  const tessera = g.suppliers.find((s) => s.format === "tessera")!;
  const got = byId(await parse("tessera", tessera.raw));
  assert.equal(got.size, tessera.itineraries.length);
  for (const want of tessera.itineraries) {
    const it = got.get(want.id)!;
    assert.ok(it.durationMinutes >= 0, `${want.id}: negative duration ${it.durationMinutes}`);
    assert.deepEqual(it.journeys, want.journeys, want.id);
    assert.equal(it.durationMinutes, want.durationMinutes, want.id);
  }
});

test("s1 tessera arrival offset is relative to the segment's own departure", async () => {
  const doc = example("tessera");
  // XB4417 departs a day after its leg date; make it land the day after it departs, too.
  const xb4417 = doc.shopResponse.scheduleTable.find((s: any) => s.carrier.marketingFlightNumber === 4417);
  xb4417.arrival.time = "01:10:00+08:00";
  xb4417.arrival.dayOffset = 1;
  const it = byId(await parse("tessera", raw(doc))).get("tessera:1.1")!;
  const seg = it.journeys[0].segments[1];
  assert.equal(seg.departureUtc, "2026-12-02T00:45:00.000Z");
  assert.equal(seg.arrivalUtc, "2026-12-02T17:10:00.000Z"); // 01:10 on 3 Dec in Singapore
  assert.equal(it.journeys[0].durationMinutes, 1360);
});

test("s1 same trip from tessera and caravel is merged, cheaper kept", async () => {
  const its = await search([
    client("caravel", "caravel", raw(example("caravel"))),
    client("tessera", "tessera", raw(example("tessera"))),
    client("keystone", "keystone", raw(example("keystone"))),
  ]);
  assert.deepEqual(
    its.map((it) => [it.id, it.totalPrice, it.durationMinutes]),
    [
      ["tessera:2.1", 136830, 1100],
      ["tessera:1.1", 140250, 1160],
      ["keystone:pP1==|oA2==|oA3==", 140680, 1100],
    ],
  );
});

test("s1 generated searches merge like the reference", async () => {
  for (const [seed, passengers] of [
    [102, { adults: 2, children: 1 }],
    [103, { adults: 1, children: 0 }],
  ] as const) {
    const g = generateSearch({ seed, passengers, floatTraps: false });
    const tessera = JSON.parse(g.suppliers.find((s) => s.format === "tessera")!.raw);
    const multi = tessera.shopResponse.legTable.filter((l: any) => l.schedules.length > 1);
    const nextDay = multi.filter((l: any) => l.schedules.some((s: any) => (s.departureDayOffset ?? 0) >= 1));
    assert.ok(nextDay.length >= 0.1 * multi.length, `seed ${seed}: only ${nextDay.length}/${multi.length} next-day legs`);
    for (const s of g.suppliers) {
      assert.ok(![...s.raw.matchAll(/"(?:USD)?(\d+\.\d{2})"/g)].some((m) => isFloatTrap(m[1])), `${s.name} has a float trap`);
    }
    const want = referenceSearch(g.suppliers, passengers.adults + passengers.children);
    const got = await search(g.suppliers.map((s) => client(s.name, s.format, s.raw)), g.request);
    assert.deepEqual(
      got.map((it) => `${it.id} ${it.totalPrice}`),
      want.map((it) => `${it.id} ${it.totalPrice}`),
      `seed ${seed}`,
    );
  }
});

// --- Money -----------------------------------------------------------------------------------

/** Caravel offer 3 (it has a ticketing fee) with amounts that lose a cent as floats. */
function caravelTraps(): any {
  const doc = example("caravel");
  const offer = doc.offers[2];
  offer.fare = {
    currency: "USD",
    total: "1032.47",
    base: "300.15",
    fees: [
      { amount: "0.29", kind: "SUPPLIER" },
      { amount: "4.35", kind: "TICKETING" },
    ],
    grandTotal: "1037.11",
  };
  for (const t of offer.travellerPricing) t.price.total = t.paxType === "ADULT" ? "345.29" : "341.89";
  return doc;
}

/** Keystone price point 1 with amounts that lose a cent as floats. */
function keystoneTraps(): any {
  const doc = example("keystone");
  const pp = doc.searchRsp.pricePoints.pricePoint[0];
  Object.assign(pp, { totalPrice: "USD1037.11", basePrice: "USD300.15", taxes: "USD736.96" });
  Object.assign(pp.pricingInfo[0], { totalPrice: "USD690.58", basePrice: "USD200.10", taxes: "USD490.48" });
  Object.assign(pp.pricingInfo[1], { totalPrice: "USD346.53", basePrice: "USD100.05", taxes: "USD246.48" });
  return doc;
}

test("s1 caravel and keystone totals are exact to the cent", async () => {
  for (const amount of ["1037.11", "0.29", "4.35", "300.15"]) assert.ok(isFloatTrap(amount), `${amount} should be a float trap`);

  const caravel = byId(await parse("caravel", raw(caravelTraps())));
  const c3 = caravel.get("caravel:3")!;
  assert.equal(c3.totalPrice, exactCents("1037.11"));
  assert.deepEqual([c3.totalPrice, c3.baseCents, c3.taxesCents, c3.feesCents], [103711, 30015, 73232, 464]);
  assert.deepEqual(c3.prices, [
    { paxType: "ADT", count: 2, unitTotalCents: 34529 },
    { paxType: "CHD", count: 1, unitTotalCents: 34189 },
  ]);
  assert.equal(caravel.get("caravel:1")!.totalPrice, 140680);

  const keystone = await parse("keystone", raw(keystoneTraps()));
  assert.deepEqual(
    keystone.map((it) => [it.id, it.totalPrice, it.baseCents, it.taxesCents]),
    [
      ["keystone:pP1==|oA1==|oA3==", 103711, 30015, 73696],
      ["keystone:pP1==|oA2==|oA3==", 103711, 30015, 73696],
      ["keystone:pP2==|oC1==|oC2==", 388360, 354750, 33610],
    ],
  );
  assert.deepEqual(keystone[0].prices, [
    { paxType: "ADT", count: 2, unitTotalCents: 34529 },
    { paxType: "CHD", count: 1, unitTotalCents: 34653 },
  ]);

  // The same through the service, with generated data full of such amounts.
  const g = generateSearch({ seed: 104 });
  const traps = g.suppliers
    .filter((s) => s.format !== "tessera")
    .flatMap((s) => [...s.raw.matchAll(/"(?:USD)?(\d+\.\d{2})"/g)].map((m) => m[1]))
    .filter(isFloatTrap);
  assert.ok(traps.length >= 20, `only ${traps.length} float traps generated`);
  for (const s of g.suppliers.filter((s) => s.format !== "tessera")) {
    const got = await parse(s.format, s.raw, s.name);
    assert.deepEqual(
      got.map((it) => [it.id, it.totalPrice, it.baseCents, it.taxesCents, it.feesCents, it.prices]),
      s.itineraries.map((it) => [it.id, it.totalPrice, it.baseCents, it.taxesCents, it.feesCents, it.prices]),
      s.name,
    );
  }
});

test("s1 toMinorUnits converts exactly", async () => {
  const app = await loadApp();
  const table: [string, number][] = [
    ["0.00", 0],
    ["0.29", 29],
    ["4.35", 435],
    ["1.13", 113],
    ["19.99", 1999],
    ["1037.11", 103711],
    ["123456789.01", 12345678901],
  ];
  for (const [input, cents] of table) assert.equal(app.toMinorUnits(input), cents, `toMinorUnits(${JSON.stringify(input)})`);
});

test("s1 malformed amounts are rejected", async () => {
  const app = await loadApp();
  for (const bad of ["12.345", "1e3", "", "-5.00", "12.5", "1,037.11", " 1.00"]) {
    const doc = example("caravel");
    doc.offers[0].fare.grandTotal = bad;
    await assert.rejects(async () => parse("caravel", raw(doc)), app.SupplierPayloadError, `caravel grandTotal ${JSON.stringify(bad)}`);
  }
  for (const bad of ["EUR1406.80", "USD1.234", "USD", "1406.80", "usd1406.80"]) {
    const doc = example("keystone");
    doc.searchRsp.pricePoints.pricePoint[0].totalPrice = bad;
    await assert.rejects(async () => parse("keystone", raw(doc)), app.SupplierPayloadError, `keystone totalPrice ${JSON.stringify(bad)}`);
  }
});

// --- Regressions -----------------------------------------------------------------------------

test("s1 alternate-date groups use their own dates", async () => {
  // Itinerary 2 only (no next-day connection), searched for three date pairs.
  const doc = example("tessera");
  const [group] = doc.shopResponse.groups;
  const itinerary = group.itineraries.find((it: any) => it.id === 2);
  doc.shopResponse.groups = [
    ["2026-12-01", "2026-12-08"],
    ["2026-11-30", "2026-12-07"],
    ["2026-12-02", "2026-12-09"],
  ].map(([out, back], i) => ({
    header: { slices: [{ ...group.header.slices[0], date: out }, { ...group.header.slices[1], date: back }] },
    itineraries: [{ ...itinerary, id: 10 + i }],
  }));
  const its = await parse("tessera", raw(doc));
  assert.deepEqual(
    its.map((it) => [it.id, it.journeys.map((j) => j.segments[0].departureUtc)]),
    [
      ["tessera:10.1", ["2026-12-01T04:05:00.000Z", "2026-12-07T17:35:00.000Z"]],
      ["tessera:11.1", ["2026-11-30T04:05:00.000Z", "2026-12-06T17:35:00.000Z"]],
      ["tessera:12.1", ["2026-12-02T04:05:00.000Z", "2026-12-08T17:35:00.000Z"]],
    ],
  );
});

test("s1 caravel half-hour offsets and segRef joins", async () => {
  const its = byId(await parse("caravel", raw(example("caravel"))));
  const [xb581, xb4417] = its.get("caravel:1")!.journeys[0].segments;
  assert.equal(xb581.arrivalUtc, "2026-12-01T21:30:00.000Z"); // 03:00 in Delhi (+05:30)
  assert.equal(xb4417.departureUtc, "2026-12-02T00:45:00.000Z");
  assert.equal(xb4417.operatingCarrier, "ZK");
  // Offer 2 lists its segment fares as 3, 1, 2; offer 3 numbers its segments 4, 5, 6.
  const classes = (id: string) => its.get(id)!.journeys.flatMap((j) => j.segments.map((s) => `${s.bookingCode}/${s.cabin}/${s.fareBasis}`));
  assert.deepEqual(classes("caravel:2"), ["J/BUSINESS/JFLXXW", "J/BUSINESS/JFLXXW", "Q/ECONOMY/QSAV1"]);
  assert.deepEqual(classes("caravel:3"), ["L/ECONOMY/LSTPXW", "L/ECONOMY/LSTPXW", "Q/ECONOMY/LSTPXW"]);
  assert.equal(its.get("caravel:1")!.seatsAvailable, 4);
});

test("s1 keystone single-element lists and cartesian expansion", async () => {
  const its = await parse("keystone", raw(example("keystone")));
  assert.deepEqual(
    its.map((it) => [it.id, it.totalPrice, it.seatsAvailable, it.journeys[0].segments.map((s) => s.flightNumber).join("+")]),
    [
      ["keystone:pP1==|oA1==|oA3==", 140680, 4, "XB581+XB4417"],
      ["keystone:pP1==|oA2==|oA3==", 140680, 5, "XB583+XB4419"],
      ["keystone:pP2==|oC1==|oC2==", 388360, 2, "XB581+XB4417"],
    ],
  );
  // A response with a single price point sends it as a bare object.
  const doc = example("keystone");
  doc.searchRsp.pricePoints.pricePoint = doc.searchRsp.pricePoints.pricePoint[1];
  assert.deepEqual((await parse("keystone", raw(doc))).map((it) => it.id), ["keystone:pP2==|oC1==|oC2=="]);
});

test("s1 business, K vs L and codeshares stay separate products", async () => {
  const app = await loadApp();
  const caravel = await parse("caravel", raw(example("caravel")));
  const keystone = await parse("keystone", raw(example("keystone")));
  // The same aircraft as XB4417, sold under the operating carrier's own number.
  const doc = example("caravel");
  const own = doc.offers[0];
  own.offerId = "own";
  Object.assign(own.journeys[0].segments[1], { airline: "ZK", flightNo: "112" });
  const [zk112] = (await parse("caravel", raw({ ...doc, offers: [own] }), "direct"));
  const merged: It[] = app.mergeItineraries([caravel, keystone, [zk112]], ["caravel", "keystone", "direct"]);
  assert.deepEqual(
    merged.map((it) => it.id),
    ["caravel:3", "keystone:pP1==|oA2==|oA3==", "caravel:1", "direct:own", "caravel:2"],
  );
});

test("s1 seats count adults and children, and are checked before merging", async () => {
  const caravel = example("caravel");
  caravel.offers[0].seatsBookable = 2; // the preferred copy of the XB581 K trip can't seat 3
  const its = await search([client("caravel", "caravel", raw(caravel)), client("keystone", "keystone", raw(example("keystone")))]);
  assert.deepEqual(
    its.map((it) => it.id),
    ["caravel:3", "keystone:pP1==|oA2==|oA3==", "keystone:pP1==|oA1==|oA3=="],
  );
  const two = await search([client("caravel", "caravel", raw(caravel))], { ...REQUEST, passengers: { adults: 2, children: 0 } });
  assert.deepEqual(two.map((it) => it.id), ["caravel:3", "caravel:1", "caravel:2"]);
});
