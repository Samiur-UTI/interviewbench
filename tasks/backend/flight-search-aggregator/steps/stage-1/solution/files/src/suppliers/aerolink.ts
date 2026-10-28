// AeroLink: nested JSON (offers -> journeys -> segments), local times with UTC offsets, and
// prices as USD decimal strings. AeroLink converts fares and carrier taxes filed in EUR/GBP/AED/SGD
// to USD with up to 2 decimals; carrier service fees (e.g. YR) are whole dollars.
//
// {
//   "searchId": "al-7f3a", "currency": "USD",
//   "offers": [{
//     "offerId": "AL-000123", "validatingCarrier": "XB", "seatsLeft": 4,
//     "journeys": [{ "segments": [{ "carrier": "XB", "flightNo": "581", "from": "LHR", "to": "DXB",
//                                   "dep": "2026-12-01T15:40:00+00:00", "arr": "2026-12-02T01:05:00+04:00",
//                                   "cabin": "Y", "rbd": "K" }] }, ...],
//     "price": { "filedCurrency": "GBP", "base": "578.68",
//                "taxes": [{ "code": "YQ", "amount": "36.41" }, ...] },
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

/** An amount we can't read exactly makes the whole response unusable: never guess a price. */
function amount(value: unknown, path: string): number {
  try {
    return toMinorUnits(str(value, path));
  } catch (err) {
    if (err instanceof SupplierPayloadError) throw err;
    throw new SupplierPayloadError(`${path}: ${(err as Error).message}`);
  }
}

function totalPrice(value: unknown, path: string): number {
  const price = obj(value, path);
  let total = amount(price.base, `${path}.base`);
  arr(price.taxes, `${path}.taxes`).forEach((t, i) => {
    total += amount(obj(t, `${path}.taxes[${i}]`).amount, `${path}.taxes[${i}].amount`);
  });
  if (!Number.isSafeInteger(total)) throw new SupplierPayloadError(`${path}: total out of range`);
  return total;
}

export function parseAeroLink(raw: string, supplier: string): Itinerary[] {
  const doc = obj(parseJson(raw, supplier), supplier);
  if (doc.currency !== "USD") throw new SupplierPayloadError(`${supplier}: currency must be USD`);
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
