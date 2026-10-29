// Tessera: description tables plus references. See docs/suppliers/tessera.md.
//
// { "shopResponse": {
//     "scheduleTable": [{ "id": 3, "departure": { "airport": "DXB", "time": "22:30:00+04:00" },
//                         "arrival": { "airport": "DEL", "time": "03:00:00+05:30", "dayOffset": 1 },
//                         "carrier": { "marketing": "XB", "marketingFlightNumber": 581, "operating": "XB" }, ... }],
//     "fareComponentTable": [{ "id": 11, "fareBasis": "KLOWXW", "paxType": "ADT", ... }],
//     "legTable": [{ "id": 2, "schedules": [{ "ref": 3 }, { "ref": 14, "departureDayOffset": 1 }] }],
//     "groups": [{
//       "header": { "slices": [{ "date": "2026-12-01", "from": "DXB", "to": "SIN" }, ...] },
//       "itineraries": [{ "id": 1, "legs": [{ "ref": 2 }, { "ref": 5 }],
//         "quotes": [{ "brandId": "SAVER", "fare": {
//           "validatingCarrier": "XB",
//           "paxQuotes": [{ "paxQuote": { "paxType": "ADT", "paxCount": 2,
//             "fareComponents": [{ "ref": 11, "segments": [{ "segment": { "bookingCode": "K", "cabinCode": "Y", "seatsAvailable": 4 } }, ...] }],
//             "perPaxTotal": { "totalCents": 50620, ... } } }, ...],
//           "totalFare": { "totalCents": 140250, "baseCents": 113300, "taxCents": 26950, "currency": "USD" } } }] }] }] } }
//
// - Tables are referenced by id. Ids are sparse and the tables are not sorted.
// - Schedules carry local times with their offset but no date. A leg's flights are dated from its
//   group's slice date (one group per date combination searched) plus the leg's
//   departureDayOffset for that flight, which is omitted when 0. An arrival dayOffset is counted
//   from the flight's own departure date.
// - Booking classes are listed per fare component, in flight order across all legs: one fare
//   component can cover several flights, even on different legs.
// - Every quote is a separately sellable offer. Amounts are integer US cents; perPaxTotal is
//   per passenger, totalFare is for everyone.

import { SupplierPayloadError } from "../errors.ts";
import { addDays, localToUtcIso } from "../time.ts";
import type { Cabin, Itinerary, Journey, PaxPrice, PaxType, Segment } from "../types.ts";
import { arr, int, lookup, obj, parseJson, str } from "./fields.ts";
import type { Obj } from "./fields.ts";
import { byPaxType, journeyTotals, toJourney } from "./normalise.ts";

const CABINS: Record<string, Cabin> = { Y: "ECONOMY", S: "PREMIUM_ECONOMY", C: "BUSINESS", J: "BUSINESS", F: "FIRST", P: "FIRST" };
const PAX_TYPES: Record<string, PaxType> = { ADT: "ADT", CNN: "CHD" };
const TIME = /^(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/;

interface Endpoint {
  airport: string;
  time: string; // "HH:mm:ss"
  offset: string; // "+05:30"
}

interface Schedule {
  marketingCarrier: string;
  flightNumber: string;
  operatingCarrier: string;
  departure: Endpoint;
  arrival: Endpoint;
  arrivalDayOffset: number; // days between the local departure and arrival dates
}

interface ScheduleRef {
  ref: number;
  departureDayOffset: number; // days from the slice date to this flight's local departure date
}

interface LegDescription {
  schedules: ScheduleRef[];
}

interface FlightClass {
  bookingCode: string;
  cabin: Cabin;
  fareBasis: string;
}

/** Indexes a description table by id. */
function table<T>(value: unknown, path: string, read: (row: Obj, path: string) => T): Map<number, T> {
  const rows = new Map<number, T>();
  arr(value, path).forEach((v, i) => {
    const row = obj(v, `${path}[${i}]`);
    const id = int(row.id, `${path}[${i}].id`);
    if (rows.has(id)) throw new SupplierPayloadError(`${path}: duplicate id ${id}`);
    rows.set(id, read(row, `${path}[${i}]`));
  });
  return rows;
}

function readEndpoint(value: unknown, path: string): Endpoint {
  const e = obj(value, path);
  const m = TIME.exec(str(e.time, `${path}.time`));
  if (!m) throw new SupplierPayloadError(`${path}.time must be HH:mm:ss±hh:mm`);
  return { airport: str(e.airport, `${path}.airport`), time: m[1], offset: m[2] };
}

function readSchedule(row: Obj, path: string): Schedule {
  const carrier = obj(row.carrier, `${path}.carrier`);
  const marketing = str(carrier.marketing, `${path}.carrier.marketing`);
  const arrival = obj(row.arrival, `${path}.arrival`);
  return {
    marketingCarrier: marketing,
    flightNumber: marketing + String(int(carrier.marketingFlightNumber, `${path}.carrier.marketingFlightNumber`, 1)),
    operatingCarrier: carrier.operating === undefined ? marketing : str(carrier.operating, `${path}.carrier.operating`),
    departure: readEndpoint(row.departure, `${path}.departure`),
    arrival: readEndpoint(arrival, `${path}.arrival`),
    arrivalDayOffset: arrival.dayOffset === undefined ? 0 : int(arrival.dayOffset, `${path}.arrival.dayOffset`, -1),
  };
}

function readLeg(row: Obj, path: string): LegDescription {
  return {
    schedules: arr(row.schedules, `${path}.schedules`).map((value, i) => {
      const p = `${path}.schedules[${i}]`;
      const s = obj(value, p);
      return {
        ref: int(s.ref, `${p}.ref`),
        // Omitted when 0, like every default in this format.
        departureDayOffset: s.departureDayOffset === undefined ? 0 : int(s.departureDayOffset, `${p}.departureDayOffset`, -1),
      };
    }),
  };
}

/** A flight without its fare: date and time resolved, booking class not yet known. */
type Flight = Omit<Segment, "bookingCode" | "cabin" | "fareBasis">;

/** The flights of one itinerary leg whose slice date is `date`. */
function legFlights(leg: LegDescription, date: string, schedules: Map<number, Schedule>, path: string): Flight[] {
  return leg.schedules.map((sr, i) => {
    const s = lookup(schedules, sr.ref, `${path}.schedules[${i}].ref`);
    const departureDate = addDays(date, sr.departureDayOffset);
    const arrivalDate = addDays(departureDate, s.arrivalDayOffset);
    return {
      marketingCarrier: s.marketingCarrier,
      flightNumber: s.flightNumber,
      operatingCarrier: s.operatingCarrier,
      origin: s.departure.airport,
      destination: s.arrival.airport,
      departureUtc: localToUtcIso(`${departureDate}T${s.departure.time}`, s.departure.offset),
      arrivalUtc: localToUtcIso(`${arrivalDate}T${s.arrival.time}`, s.arrival.offset),
    };
  });
}

/** The booking class of every flight, in flight order across all legs, from one passenger quote. */
function flightClasses(paxQuote: Obj, fareBases: Map<number, string>, path: string): FlightClass[] {
  return arr(paxQuote.fareComponents, `${path}.fareComponents`).flatMap((v, i) => {
    const p = `${path}.fareComponents[${i}]`;
    const fc = obj(v, p);
    const fareBasis = lookup(fareBases, int(fc.ref, `${p}.ref`), `${p}.ref`);
    return arr(fc.segments, `${p}.segments`).map((s, k) => {
      const seg = obj(obj(s, `${p}.segments[${k}]`).segment, `${p}.segments[${k}].segment`);
      const cabin = CABINS[str(seg.cabinCode, `${p}.segments[${k}].segment.cabinCode`)];
      if (!cabin) throw new SupplierPayloadError(`${p}.segments[${k}].segment.cabinCode: unknown cabin ${String(seg.cabinCode)}`);
      return { bookingCode: str(seg.bookingCode, `${p}.segments[${k}].segment.bookingCode`), cabin, fareBasis };
    });
  });
}

/** Fewest seats left on any flight, for any passenger type. */
function seatsAvailable(paxQuotes: Obj[], path: string): number {
  let seats = Infinity;
  paxQuotes.forEach((pq, i) => {
    arr(pq.fareComponents, `${path}[${i}].fareComponents`).forEach((fc, k) => {
      const p = `${path}[${i}].fareComponents[${k}]`;
      arr(obj(fc, p).segments, `${p}.segments`).forEach((s, n) => {
        const seg = obj(obj(s, `${p}.segments[${n}]`).segment, `${p}.segments[${n}].segment`);
        seats = Math.min(seats, int(seg.seatsAvailable, `${p}.segments[${n}].segment.seatsAvailable`));
      });
    });
  });
  if (seats === Infinity) throw new SupplierPayloadError(`${path} has no flights`);
  return seats;
}

function toItinerary(supplier: string, ref: string, flights: Flight[][], quote: Obj, fareBases: Map<number, string>, path: string): Itinerary {
  const fare = obj(quote.fare, `${path}.fare`);
  const paxQuotes = arr(fare.paxQuotes, `${path}.fare.paxQuotes`).map((v, i) =>
    obj(obj(v, `${path}.fare.paxQuotes[${i}]`).paxQuote, `${path}.fare.paxQuotes[${i}].paxQuote`),
  );
  const adultIndex = paxQuotes.findIndex((pq) => pq.paxType === "ADT");
  if (adultIndex === -1) throw new SupplierPayloadError(`${path}: no ADT quote`);
  const classes = flightClasses(paxQuotes[adultIndex], fareBases, `${path}.fare.paxQuotes[${adultIndex}].paxQuote`);
  const flightCount = flights.reduce((n, leg) => n + leg.length, 0);
  if (classes.length !== flightCount) {
    throw new SupplierPayloadError(`${path}: ${classes.length} booking classes for ${flightCount} flights`);
  }
  let next = 0;
  const journeys: Journey[] = flights.map((leg, i) => toJourney(leg.map((f) => ({ ...f, ...classes[next++] })), `${path}.legs[${i}]`));

  const prices: PaxPrice[] = byPaxType(paxQuotes.map((pq, i) => {
    const p = `${path}.fare.paxQuotes[${i}].paxQuote`;
    const paxType = PAX_TYPES[str(pq.paxType, `${p}.paxType`)];
    if (!paxType) throw new SupplierPayloadError(`${p}.paxType: unsupported ${String(pq.paxType)}`);
    return {
      paxType,
      count: int(pq.paxCount, `${p}.paxCount`, 1),
      unitTotalCents: int(obj(pq.perPaxTotal, `${p}.perPaxTotal`).totalCents, `${p}.perPaxTotal.totalCents`),
    };
  }), `${path}.fare.paxQuotes`);
  const totalFare = obj(fare.totalFare, `${path}.fare.totalFare`);
  if (totalFare.currency !== "USD") throw new SupplierPayloadError(`${path}.fare.totalFare: currency must be USD`);
  const totalPrice = int(totalFare.totalCents, `${path}.fare.totalFare.totalCents`);
  if (prices.reduce((sum, p) => sum + p.unitTotalCents * p.count, 0) !== totalPrice) {
    throw new SupplierPayloadError(`${path}: passenger totals don't add up to totalFare`);
  }
  return {
    id: `${supplier}:${ref}`,
    supplier,
    supplierRef: ref,
    validatingCarrier: str(fare.validatingCarrier, `${path}.fare.validatingCarrier`),
    ...(quote.brandId === undefined ? {} : { brand: str(quote.brandId, `${path}.brandId`) }),
    journeys,
    totalPrice,
    baseCents: int(totalFare.baseCents, `${path}.fare.totalFare.baseCents`),
    taxesCents: int(totalFare.taxCents, `${path}.fare.totalFare.taxCents`),
    feesCents: 0,
    prices,
    seatsAvailable: seatsAvailable(paxQuotes, `${path}.fare.paxQuotes`),
    ...journeyTotals(journeys),
  };
}

export function parseTessera(raw: string, supplier: string): Itinerary[] {
  const root = obj(parseJson(raw, supplier), supplier);
  const path = `${supplier}.shopResponse`;
  const doc = obj(root.shopResponse, path);
  const schedules = table(doc.scheduleTable, `${path}.scheduleTable`, readSchedule);
  const legs = table(doc.legTable, `${path}.legTable`, readLeg);
  const fareBases = table(doc.fareComponentTable, `${path}.fareComponentTable`, (row, p) => str(row.fareBasis, `${p}.fareBasis`));

  const itineraries: Itinerary[] = [];
  arr(doc.groups, `${path}.groups`).forEach((g, gi) => {
    const gp = `${path}.groups[${gi}]`;
    const group = obj(g, gp);
    const slices = arr(obj(group.header, `${gp}.header`).slices, `${gp}.header.slices`).map((s, i) =>
      str(obj(s, `${gp}.header.slices[${i}]`).date, `${gp}.header.slices[${i}].date`),
    );
    arr(group.itineraries, `${gp}.itineraries`).forEach((v, ii) => {
      const ip = `${gp}.itineraries[${ii}]`;
      const it = obj(v, ip);
      const legRefs = arr(it.legs, `${ip}.legs`);
      if (legRefs.length !== slices.length) throw new SupplierPayloadError(`${ip}: ${legRefs.length} legs for ${slices.length} slices`);
      const flights = legRefs.map((l, i) => {
        const leg = lookup(legs, int(obj(l, `${ip}.legs[${i}]`).ref, `${ip}.legs[${i}].ref`), `${ip}.legs[${i}].ref`);
        return legFlights(leg, slices[i], schedules, `${ip}.legs[${i}]`);
      });
      const id = int(it.id, `${ip}.id`);
      arr(it.quotes, `${ip}.quotes`).forEach((q, qi) => {
        itineraries.push(toItinerary(supplier, `${id}.${qi + 1}`, flights, obj(q, `${ip}.quotes[${qi}]`), fareBases, `${ip}.quotes[${qi}]`));
      });
    });
  });
  return itineraries;
}
