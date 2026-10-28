// Keystone: keyed lists and price points, converted from XML to JSON. See docs/suppliers/keystone.md.
//
// { "searchRsp": { "currency": "USD",
//     "segmentIndex": { "seg": [{ "key": "q8Zt/AAAAg==", "carrier": "XB", "flightNumber": "581",
//                                 "origin": "DXB", "destination": "DEL",
//                                 "departs": "2026-12-01T22:30:00.000+04:00", "arrives": "2026-12-02T03:00:00.000+05:30",
//                                 "codeshareInfo": { "operatingCarrier": "ZK", "#text": "..." } }, ...] },
//     "fareInfoIndex": { "fareInfo": [{ "key": "fI0x/1==", "fareBasis": "KLOWXW", "brand": { "name": "SAVER" }, ... }] },
//     "routeIndex": { "route": { "key": "rT1==", "leg": [{ "key": "lG0==", "group": 0 }, { "key": "lG1==", "group": 1 }] } },
//     "pricePoints": { "pricePoint": [{
//       "key": "pP1==", "totalPrice": "USD1406.80", "basePrice": "USD1133.00", "taxes": "USD273.80",
//       "pricingInfo": [{ "platingCarrier": "XB", "totalPrice": "USD1016.70",
//                         "passengerType": [{ "code": "ADT" }, { "code": "ADT" }],
//                         "flightOptions": { "flightOption": [{ "legRef": "lG0==",
//                           "option": [{ "key": "oA1==", "bookingInfo": [{ "bookingCode": "K", "bookingCount": 4,
//                             "cabinClass": "Economy", "fareInfoRef": "fI0x/1==", "segmentRef": "q8Zt/AAAAg==" }, ...] }, ...] }, ...] } },
//                       ...] }] } } }
//
// - A list with one element arrives as a bare object (XML->JSON), and an empty one is omitted.
// - Keys are opaque and case-sensitive (they contain "/", "+" and "=").
// - A price point offers every combination of its per-leg options, all at the same price. The
//   options are listed again under every pricingInfo; the first pricingInfo's keys name the offer.
// - pricingInfo amounts cover all passengers of that type, one passengerType entry per person.
// - Amounts are strings prefixed with the currency: "USD1406.80".

import { SupplierPayloadError } from "../errors.ts";
import { toMinorUnits } from "../money.ts";
import { toUtcIso } from "../time.ts";
import type { Cabin, Itinerary, PaxPrice, PaxType, Segment } from "../types.ts";
import { int, lookup, obj, oneOrMany, parseJson, str } from "./fields.ts";
import type { Obj } from "./fields.ts";
import { byPaxType, journeyTotals, toJourney } from "./normalise.ts";

const CABINS: Record<string, Cabin> = { Economy: "ECONOMY", PremiumEconomy: "PREMIUM_ECONOMY", Business: "BUSINESS", First: "FIRST" };
const PAX_TYPES: Record<string, PaxType> = { ADT: "ADT", CNN: "CHD" };

interface FareInfo {
  fareBasis: string;
  brand?: string;
}

/** An option: the flights of one leg, with their booking classes. */
interface Option {
  key: string;
  segments: Segment[];
  seats: number; // fewest seats left on any of its flights
  brand?: string;
}

function usd(value: unknown, path: string): number {
  return toMinorUnits(str(value, path).slice(3));
}

/** Indexes a keyed list. */
function keyed<T>(value: unknown, path: string, read: (row: Obj, path: string) => T): Map<string, T> {
  const rows = new Map<string, T>();
  oneOrMany(value, path).forEach((v, i) => {
    const row = obj(v, `${path}[${i}]`);
    const key = str(row.key, `${path}[${i}].key`);
    if (rows.has(key)) throw new SupplierPayloadError(`${path}: duplicate key ${key}`);
    rows.set(key, read(row, `${path}[${i}]`));
  });
  return rows;
}

function readFareInfo(row: Obj, path: string): FareInfo {
  const fare: FareInfo = { fareBasis: str(row.fareBasis, `${path}.fareBasis`) };
  if (row.brand !== undefined) fare.brand = str(obj(row.brand, `${path}.brand`).name, `${path}.brand.name`);
  return fare;
}

function readOption(value: unknown, path: string, segments: Map<string, Obj>, fares: Map<string, FareInfo>): Option {
  const o = obj(value, path);
  let seats = Infinity;
  let brand: string | undefined;
  const flights = oneOrMany(o.bookingInfo, `${path}.bookingInfo`).map((v, i) => {
    const p = `${path}.bookingInfo[${i}]`;
    const bi = obj(v, p);
    const s = lookup(segments, str(bi.segmentRef, `${p}.segmentRef`), `${p}.segmentRef`);
    const fare = lookup(fares, str(bi.fareInfoRef, `${p}.fareInfoRef`), `${p}.fareInfoRef`);
    const cabin = CABINS[str(bi.cabinClass, `${p}.cabinClass`)];
    if (!cabin) throw new SupplierPayloadError(`${p}.cabinClass: unknown cabin ${String(bi.cabinClass)}`);
    seats = Math.min(seats, int(bi.bookingCount, `${p}.bookingCount`));
    brand ??= fare.brand;
    const sp = `segment ${String(s.key)}`;
    const carrier = str(s.carrier, `${sp}.carrier`);
    const segment: Segment = {
      marketingCarrier: carrier,
      flightNumber: carrier + str(s.flightNumber, `${sp}.flightNumber`),
      operatingCarrier:
        s.codeshareInfo === undefined ? carrier : str(obj(s.codeshareInfo, `${sp}.codeshareInfo`).operatingCarrier, `${sp}.codeshareInfo.operatingCarrier`),
      origin: str(s.origin, `${sp}.origin`),
      destination: str(s.destination, `${sp}.destination`),
      departureUtc: toUtcIso(str(s.departs, `${sp}.departs`)),
      arrivalUtc: toUtcIso(str(s.arrives, `${sp}.arrives`)),
      bookingCode: str(bi.bookingCode, `${p}.bookingCode`),
      cabin,
      fareBasis: fare.fareBasis,
    };
    return segment;
  });
  if (flights.length === 0) throw new SupplierPayloadError(`${path} has no bookingInfo`);
  return { key: str(o.key, `${path}.key`), segments: flights, seats, brand };
}

/** Every way to pick one option per leg, legs in order. */
function combinations(perLeg: Option[][]): Option[][] {
  return perLeg.reduce<Option[][]>((combos, options) => combos.flatMap((c) => options.map((o) => [...c, o])), [[]]);
}

function paxPrice(pricingInfo: Obj, path: string): PaxPrice {
  const passengers = oneOrMany(pricingInfo.passengerType, `${path}.passengerType`).map((v, i) =>
    str(obj(v, `${path}.passengerType[${i}]`).code, `${path}.passengerType[${i}].code`),
  );
  const paxType = PAX_TYPES[passengers[0]];
  if (!paxType || passengers.some((code) => code !== passengers[0])) {
    throw new SupplierPayloadError(`${path}.passengerType: unsupported ${JSON.stringify(passengers)}`);
  }
  return { paxType, count: passengers.length, unitTotalCents: usd(pricingInfo.totalPrice, `${path}.totalPrice`) / passengers.length };
}

export function parseKeystone(raw: string, supplier: string): Itinerary[] {
  const root = obj(parseJson(raw, supplier), supplier);
  const path = `${supplier}.searchRsp`;
  const doc = obj(root.searchRsp, path);
  if (doc.currency !== "USD") throw new SupplierPayloadError(`${supplier}: currency must be USD`);
  const segments = keyed(obj(doc.segmentIndex, `${path}.segmentIndex`).seg, `${path}.segmentIndex.seg`, (row) => row);
  const fares = keyed(obj(doc.fareInfoIndex, `${path}.fareInfoIndex`).fareInfo, `${path}.fareInfoIndex.fareInfo`, readFareInfo);
  const route = obj(oneOrMany(obj(doc.routeIndex, `${path}.routeIndex`).route, `${path}.routeIndex.route`)[0], `${path}.routeIndex.route[0]`);
  const legOrder = oneOrMany(route.leg, `${path}.routeIndex.route[0].leg`)
    .map((v, i) => obj(v, `${path}.routeIndex.route[0].leg[${i}]`))
    .map((leg, i) => ({ key: str(leg.key, `${path}.routeIndex.route[0].leg[${i}].key`), group: int(leg.group, `${path}.routeIndex.route[0].leg[${i}].group`) }))
    .sort((a, b) => a.group - b.group)
    .map((leg) => leg.key);
  if (legOrder.length === 0) throw new SupplierPayloadError(`${path}.routeIndex.route[0] has no legs`);

  const itineraries: Itinerary[] = [];
  oneOrMany(obj(doc.pricePoints, `${path}.pricePoints`).pricePoint, `${path}.pricePoints.pricePoint`).forEach((v, i) => {
    const pp = `${path}.pricePoints.pricePoint[${i}]`;
    const point = obj(v, pp);
    const pointKey = str(point.key, `${pp}.key`);
    const pricingInfos = oneOrMany(point.pricingInfo, `${pp}.pricingInfo`).map((p, k) => obj(p, `${pp}.pricingInfo[${k}]`));
    if (pricingInfos.length === 0) throw new SupplierPayloadError(`${pp} has no pricingInfo`);
    const first = pricingInfos[0];
    const fp = `${pp}.pricingInfo[0]`;

    const optionsByLeg = new Map<string, Option[]>();
    oneOrMany(obj(first.flightOptions, `${fp}.flightOptions`).flightOption, `${fp}.flightOptions.flightOption`).forEach((f, k) => {
      const p = `${fp}.flightOptions.flightOption[${k}]`;
      const fo = obj(f, p);
      optionsByLeg.set(
        str(fo.legRef, `${p}.legRef`),
        oneOrMany(fo.option, `${p}.option`).map((o, n) => readOption(o, `${p}.option[${n}]`, segments, fares)),
      );
    });
    const perLeg = legOrder.map((legKey) => lookup(optionsByLeg, legKey, `${pp}: leg`));

    const prices = byPaxType(pricingInfos.map((p, k) => paxPrice(p, `${pp}.pricingInfo[${k}]`)), `${pp}.pricingInfo`);
    const validatingCarrier = str(first.platingCarrier, `${fp}.platingCarrier`);
    const totalPrice = usd(point.totalPrice, `${pp}.totalPrice`);
    const baseCents = usd(point.basePrice, `${pp}.basePrice`);
    const taxesCents = usd(point.taxes, `${pp}.taxes`);

    for (const combo of combinations(perLeg)) {
      const ref = [pointKey, ...combo.map((o) => o.key)].join("|");
      const journeys = combo.map((o, k) => toJourney(o.segments, `${pp} option ${o.key} (leg ${k})`));
      const brand = combo[0].brand;
      itineraries.push({
        id: `${supplier}:${ref}`,
        supplier,
        supplierRef: ref,
        validatingCarrier,
        ...(brand === undefined ? {} : { brand }),
        journeys,
        totalPrice,
        baseCents,
        taxesCents,
        feesCents: 0,
        prices: prices.map((p) => ({ ...p })),
        seatsAvailable: Math.min(...combo.map((o) => o.seats)),
        ...journeyTotals(journeys),
      });
    }
  });
  return itineraries;
}
