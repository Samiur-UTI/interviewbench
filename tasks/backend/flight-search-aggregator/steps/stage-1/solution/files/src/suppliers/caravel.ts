// Caravel: offer-centric JSON with lookup dictionaries. See docs/suppliers/caravel.md.
//
// { "meta": { "resultCount": 250, "currency": "USD" },
//   "offers": [{
//     "offerId": "1", "seatsBookable": 4, "validatingAirlines": ["XB"],
//     "journeys": [{ "segments": [{ "segRef": "1", "airline": "XB", "flightNo": "581",
//                                   "board":  { "airport": "DXB", "localTime": "2026-12-01T22:30:00" },
//                                   "alight": { "airport": "DEL", "localTime": "2026-12-02T03:00:00" },
//                                   "operatedBy": { "airline": "XB" }, ... }] }, ...],
//     "fare": { "currency": "USD", "total": "1406.80", "base": "1133.00",
//               "fees": [{ "amount": "0.00", "kind": "TICKETING" }], "grandTotal": "1406.80" },
//     "travellerPricing": [{ "travellerId": "1", "paxType": "ADULT",
//                            "price": { "total": "508.35", "base": "412.00" },
//                            "segmentFares": [{ "segRef": "1", "cabin": "ECONOMY", "rbd": "K", "fareBasis": "KLOWXW",
//                                               "brand": "SAVER", "amenities": [...] }, ...] }, ...]
//   }],
//   "lookups": { "airports": { "DEL": { "utcOffset": "+05:30", ... } }, "airlines": {...}, "equipment": {...} } }
//
// - Local times carry no offset: it comes from lookups.airports.
// - Cabin, booking class and fare basis are per traveller and segment, joined by segRef. segRefs
//   are unique within one offer only, and segmentFares are not always in segment order.
// - travellerPricing has one entry per traveller. Amounts are USD decimal strings; grandTotal is
//   what the customer pays (total + fees).

import { SupplierPayloadError } from "../errors.ts";
import { toMinorUnits } from "../money.ts";
import { localToUtcIso } from "../time.ts";
import type { Cabin, Itinerary, PaxPrice, PaxType, Segment } from "../types.ts";
import { arr, int, lookup, obj, parseJson, str } from "./fields.ts";
import type { Obj } from "./fields.ts";
import { journeyTotals, toJourney } from "./normalise.ts";

const CABINS: ReadonlySet<string> = new Set<Cabin>(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]);
const PAX_TYPES: Record<string, PaxType> = { ADULT: "ADT", CHILD: "CHD" };

interface SegmentFare {
  cabin: Cabin;
  bookingCode: string;
  fareBasis: string;
  brand: string;
}

function readOffsets(doc: Obj, supplier: string): Map<string, string> {
  const path = `${supplier}.lookups.airports`;
  const airports = obj(obj(doc.lookups, `${supplier}.lookups`).airports, path);
  return new Map(Object.entries(airports).map(([code, a]) => [code, str(obj(a, `${path}.${code}`).utcOffset, `${path}.${code}.utcOffset`)]));
}

/** segRef -> the fare of that segment. Every traveller must agree on cabin and booking code. */
function readSegmentFares(travellers: Obj[], path: string): Map<string, SegmentFare> {
  const fares = new Map<string, SegmentFare>();
  travellers.forEach((t, i) => {
    const adult = t.paxType === "ADULT";
    arr(t.segmentFares, `${path}[${i}].segmentFares`).forEach((value, k) => {
      const p = `${path}[${i}].segmentFares[${k}]`;
      const sf = obj(value, p);
      const cabin = str(sf.cabin, `${p}.cabin`);
      if (!CABINS.has(cabin)) throw new SupplierPayloadError(`${p}.cabin: unknown cabin ${cabin}`);
      const fare: SegmentFare = {
        cabin: cabin as Cabin,
        bookingCode: str(sf.rbd, `${p}.rbd`),
        fareBasis: str(sf.fareBasis, `${p}.fareBasis`),
        brand: str(sf.brand, `${p}.brand`),
      };
      const segRef = str(sf.segRef, `${p}.segRef`);
      const seen = fares.get(segRef);
      if (seen && (seen.cabin !== fare.cabin || seen.bookingCode !== fare.bookingCode)) {
        throw new SupplierPayloadError(`${p}: travellers disagree on the class of segment ${segRef}`);
      }
      // The adult fare basis is the one we show.
      if (!seen || adult) fares.set(segRef, fare);
    });
  });
  return fares;
}

function toSegment(value: unknown, path: string, fares: Map<string, SegmentFare>, offsets: Map<string, string>): [Segment, SegmentFare] {
  const s = obj(value, path);
  const board = obj(s.board, `${path}.board`);
  const alight = obj(s.alight, `${path}.alight`);
  const origin = str(board.airport, `${path}.board.airport`);
  const destination = str(alight.airport, `${path}.alight.airport`);
  const airline = str(s.airline, `${path}.airline`);
  const fare = lookup(fares, str(s.segRef, `${path}.segRef`), `${path}.segRef`);
  const segment: Segment = {
    marketingCarrier: airline,
    flightNumber: airline + str(s.flightNo, `${path}.flightNo`),
    operatingCarrier: s.operatedBy === undefined ? airline : str(obj(s.operatedBy, `${path}.operatedBy`).airline, `${path}.operatedBy.airline`),
    origin,
    destination,
    departureUtc: localToUtcIso(str(board.localTime, `${path}.board.localTime`), lookup(offsets, origin, `${path}.board.airport`)),
    arrivalUtc: localToUtcIso(str(alight.localTime, `${path}.alight.localTime`), lookup(offsets, destination, `${path}.alight.airport`)),
    bookingCode: fare.bookingCode,
    cabin: fare.cabin,
    fareBasis: fare.fareBasis,
  };
  return [segment, fare];
}

/** One entry per passenger type, adults first. All travellers of a type must pay the same. */
function paxPrices(travellers: Obj[], path: string): PaxPrice[] {
  const byType = new Map<PaxType, PaxPrice>();
  travellers.forEach((t, i) => {
    const paxType = PAX_TYPES[str(t.paxType, `${path}[${i}].paxType`)];
    if (!paxType) throw new SupplierPayloadError(`${path}[${i}].paxType: unsupported ${String(t.paxType)}`);
    const unit = toMinorUnits(str(obj(t.price, `${path}[${i}].price`).total, `${path}[${i}].price.total`));
    const seen = byType.get(paxType);
    if (!seen) byType.set(paxType, { paxType, count: 1, unitTotalCents: unit });
    else if (seen.unitTotalCents !== unit) throw new SupplierPayloadError(`${path}[${i}]: ${paxType} travellers priced differently`);
    else seen.count++;
  });
  return (["ADT", "CHD"] as const).flatMap((type) => byType.get(type) ?? []);
}

export function parseCaravel(raw: string, supplier: string): Itinerary[] {
  const doc = obj(parseJson(raw, supplier), supplier);
  if (obj(doc.meta, `${supplier}.meta`).currency !== "USD") throw new SupplierPayloadError(`${supplier}: currency must be USD`);
  const offsets = readOffsets(doc, supplier);
  return arr(doc.offers, `${supplier}.offers`).map((value, i) => {
    const path = `${supplier}.offers[${i}]`;
    const offer = obj(value, path);
    const ref = str(offer.offerId, `${path}.offerId`);
    const travellers = arr(offer.travellerPricing, `${path}.travellerPricing`).map((t, k) => obj(t, `${path}.travellerPricing[${k}]`));
    const fares = readSegmentFares(travellers, `${path}.travellerPricing`);
    let brand: string | undefined;
    const journeys = arr(offer.journeys, `${path}.journeys`).map((j, k) => {
      const p = `${path}.journeys[${k}]`;
      const segments = arr(obj(j, p).segments, `${p}.segments`).map((s, n) => {
        const [segment, fare] = toSegment(s, `${p}.segments[${n}]`, fares, offsets);
        brand ??= fare.brand; // the brand of the first flight names the offer
        return segment;
      });
      return toJourney(segments, p);
    });
    if (journeys.length === 0) throw new SupplierPayloadError(`${path} has no journeys`);

    const fare = obj(offer.fare, `${path}.fare`);
    if (fare.currency !== "USD") throw new SupplierPayloadError(`${path}.fare: currency must be USD`);
    const total = toMinorUnits(str(fare.total, `${path}.fare.total`));
    const base = toMinorUnits(str(fare.base, `${path}.fare.base`));
    let fees = 0;
    arr(fare.fees, `${path}.fare.fees`).forEach((f, k) => {
      fees += toMinorUnits(str(obj(f, `${path}.fare.fees[${k}]`).amount, `${path}.fare.fees[${k}].amount`));
    });
    const grandTotal = toMinorUnits(str(fare.grandTotal, `${path}.fare.grandTotal`));
    if (grandTotal !== total + fees) throw new SupplierPayloadError(`${path}.fare: grandTotal is not total + fees`);
    if (base > total) throw new SupplierPayloadError(`${path}.fare: base exceeds total`);
    const prices = paxPrices(travellers, `${path}.travellerPricing`);
    if (prices.reduce((sum, p) => sum + p.unitTotalCents * p.count, 0) !== total) {
      throw new SupplierPayloadError(`${path}: traveller prices don't add up to fare.total`);
    }
    const validating = arr(offer.validatingAirlines, `${path}.validatingAirlines`);
    return {
      id: `${supplier}:${ref}`,
      supplier,
      supplierRef: ref,
      validatingCarrier: str(validating[0], `${path}.validatingAirlines[0]`),
      brand,
      journeys,
      totalPrice: grandTotal,
      baseCents: base,
      taxesCents: total - base,
      feesCents: fees,
      prices,
      seatsAvailable: int(offer.seatsBookable, `${path}.seatsBookable`),
      ...journeyTotals(journeys),
    };
  });
}
