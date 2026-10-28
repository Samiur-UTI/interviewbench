// SkyMesh: flat JSON, one row per fare. Segments are pipe-delimited strings:
//   flightNumber|from|to|depUTC(yyyyMMddHHmm)|arrUTC|bookingClass|journeyNo
// and the total is already an integer in poisha.
//
// { "status": "OK", "cur": "BDT",
//   "fares": [{ "ref": "SM-55102", "fareBasis": "KOWBD", "avail": 4, "totalMinor": 5091781,
//               "segs": ["XB581|DAC|DXB|202612011540|202612012105|K|1",
//                        "XB582|DXB|DAC|202612092315|202612100420|K|2"] }] }

import { SupplierPayloadError } from "../errors.ts";
import { minutesBetween, parseCompactUtc } from "../time.ts";
import type { Itinerary, Journey, Segment } from "../types.ts";
import { arr, int, obj, parseJson, str } from "./fields.ts";

function toSegment(value: unknown, path: string): { journeyNo: number; segment: Segment } {
  const parts = str(value, path).split("|");
  if (parts.length !== 7 || parts.some((p) => p === "")) {
    throw new SupplierPayloadError(`${path} must have 7 non-empty fields`);
  }
  const [flightNumber, origin, destination, dep, arrival, bookingClass, journeyNo] = parts;
  const n = Number(journeyNo);
  if (!Number.isInteger(n) || n < 1) throw new SupplierPayloadError(`${path}: bad journey number`);
  return {
    journeyNo: n,
    segment: {
      carrier: flightNumber.slice(0, 2),
      flightNumber,
      origin,
      destination,
      departureUtc: parseCompactUtc(dep),
      arrivalUtc: parseCompactUtc(arrival),
      bookingClass,
    },
  };
}

function toJourneys(value: unknown, path: string): Journey[] {
  const journeys: Journey[] = [];
  arr(value, path).forEach((s, i) => {
    const { journeyNo, segment } = toSegment(s, `${path}[${i}]`);
    if (journeyNo === journeys.length) journeys[journeys.length - 1].segments.push(segment);
    else if (journeyNo === journeys.length + 1) journeys.push({ segments: [segment] });
    else throw new SupplierPayloadError(`${path}[${i}]: journey numbers must be 1, 2, ... in order`);
  });
  if (journeys.length === 0) throw new SupplierPayloadError(`${path} has no segments`);
  return journeys;
}

export function parseSkyMesh(raw: string, supplier: string): Itinerary[] {
  const doc = obj(parseJson(raw, supplier), supplier);
  if (doc.status !== "OK") throw new SupplierPayloadError(`${supplier}: status ${String(doc.status)}`);
  if (doc.cur !== "BDT") throw new SupplierPayloadError(`${supplier}: currency must be BDT`);
  return arr(doc.fares, `${supplier}.fares`).map((value, i) => {
    const path = `${supplier}.fares[${i}]`;
    const fare = obj(value, path);
    const ref = str(fare.ref, `${path}.ref`);
    const journeys = toJourneys(fare.segs, `${path}.segs`);
    let durationMinutes = 0;
    for (const j of journeys) {
      durationMinutes += minutesBetween(j.segments[0].departureUtc, j.segments[j.segments.length - 1].arrivalUtc);
    }
    return {
      id: `${supplier}:${ref}`,
      supplier,
      supplierRef: ref,
      journeys,
      totalPrice: int(fare.totalMinor, `${path}.totalMinor`),
      seatsAvailable: int(fare.avail, `${path}.avail`),
      durationMinutes,
    };
  });
}
