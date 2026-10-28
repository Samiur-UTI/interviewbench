// AeroLink: nested JSON (offers -> journeys -> segments), local times with UTC offsets, and
// prices as BDT decimal strings. AeroLink converts fares and carrier taxes filed in USD/AED/SGD/MYR
// to BDT with up to 2 decimals; Bangladesh taxes are whole taka.
//
// {
//   "searchId": "al-7f3a", "currency": "BDT",
//   "offers": [{
//     "offerId": "AL-000123", "validatingCarrier": "XB", "seatsLeft": 4,
//     "journeys": [{ "segments": [{ "carrier": "XB", "flightNo": "581", "from": "DAC", "to": "DXB",
//                                   "dep": "2026-12-01T21:40:00+06:00", "arr": "2026-12-02T01:05:00+04:00",
//                                   "cabin": "Y", "rbd": "K" }] }, ...],
//     "price": { "filedCurrency": "USD", "base": "41111.13",
//                "taxes": [{ "code": "YQ", "amount": "2162.99" }, ...] },
//     "fareComponents": [...], "baggageAllowances": [...], "brandAttributes": [...], "paxBreakdown": [...]
//   }]
// }
// The four bulk arrays are not used by this service.

import { SupplierPayloadError } from "../errors.ts";
import { toMinorUnits } from "../money.ts";
import { minutesBetween, toUtcIso } from "../time.ts";
import type { Itinerary, Journey, Segment } from "../types.ts";
import { arr, int, obj, parseJson, str } from "./fields.ts";

function toSegment(value: unknown, path: string): Segment {
  const s = obj(value, path);
  const carrier = str(s.carrier, `${path}.carrier`);
  return {
    carrier,
    flightNumber: carrier + str(s.flightNo, `${path}.flightNo`),
    origin: str(s.from, `${path}.from`),
    destination: str(s.to, `${path}.to`),
    departureUtc: toUtcIso(str(s.dep, `${path}.dep`)),
    arrivalUtc: toUtcIso(str(s.arr, `${path}.arr`)),
    bookingClass: str(s.rbd, `${path}.rbd`),
  };
}

function toJourney(value: unknown, path: string): Journey {
  const segments = arr(obj(value, path).segments, `${path}.segments`);
  if (segments.length === 0) throw new SupplierPayloadError(`${path} has no segments`);
  return { segments: segments.map((s, i) => toSegment(s, `${path}.segments[${i}]`)) };
}

function totalPrice(value: unknown, path: string): number {
  const price = obj(value, path);
  let total = toMinorUnits(str(price.base, `${path}.base`));
  arr(price.taxes, `${path}.taxes`).forEach((t, i) => {
    total += toMinorUnits(str(obj(t, `${path}.taxes[${i}]`).amount, `${path}.taxes[${i}].amount`));
  });
  return total;
}

export function parseAeroLink(raw: string, supplier: string): Itinerary[] {
  const doc = obj(parseJson(raw, supplier), supplier);
  if (doc.currency !== "BDT") throw new SupplierPayloadError(`${supplier}: currency must be BDT`);
  return arr(doc.offers, `${supplier}.offers`).map((value, i) => {
    const path = `${supplier}.offers[${i}]`;
    const offer = obj(value, path);
    const ref = str(offer.offerId, `${path}.offerId`);
    const journeys = arr(offer.journeys, `${path}.journeys`).map((j, k) => toJourney(j, `${path}.journeys[${k}]`));
    if (journeys.length === 0) throw new SupplierPayloadError(`${path} has no journeys`);
    let durationMinutes = 0;
    for (const j of journeys) {
      durationMinutes += minutesBetween(j.segments[0].departureUtc, j.segments[j.segments.length - 1].arrivalUtc);
    }
    return {
      id: `${supplier}:${ref}`,
      supplier,
      supplierRef: ref,
      journeys,
      totalPrice: totalPrice(offer.price, `${path}.price`),
      seatsAvailable: int(offer.seatsLeft, `${path}.seatsLeft`),
      durationMinutes,
    };
  });
}
