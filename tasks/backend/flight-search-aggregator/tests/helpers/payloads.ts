// Seeded generator for supplier payloads. The same abstract offers can be rendered as an
// AeroLink payload, a SkyMesh payload, or directly as the Itinerary objects the service must
// produce for them, so the generator is the oracle for the parsers.
//
// Everything is invented: carriers XB/ZQ/QV/JW are fictional, the payload shapes are this task's.

export type Rng = () => number;

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number): Rng {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, min: number, max: number): number => min + Math.floor(r() * (max - min + 1));
const pick = <T>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)];

/** UTC offset of each airport, in minutes. */
export const UTC_OFFSET: Record<string, number> = { DAC: 360, DXB: 240, SIN: 480, KUL: 480, DOH: 180, CCU: 330 };
const DESTINATIONS = ["DXB", "SIN", "KUL"];
const HUBS = ["DOH", "CCU", "DXB"];
const CARRIERS = ["XB", "ZQ", "QV", "JW"];
const CLASSES = ["K", "M", "Y", "J", "C"];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BASE_DAY = Date.UTC(2026, 11, 1);

export interface GenSegment {
  flightNumber: string;
  origin: string;
  destination: string;
  depMs: number;
  arrMs: number;
  bookingClass: string;
}

export interface Amounts {
  base: string;
  taxes: { code: string; amount: string }[];
}

export interface GenOffer {
  ref: string;
  journeys: GenSegment[][];
  seats: number;
  totalMinor: number; // exact total in poisha
  amounts?: Amounts; // AeroLink price strings; derived from totalMinor when absent
}

// --- exact money helpers (independent of the code under test) ----------------------------------

/** Exact poisha for a decimal string with up to 2 decimals. */
export function exactPoisha(amount: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!m) throw new Error(`not an amount: ${amount}`);
  const value = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return Number(value);
}

export function poishaToAmount(poisha: number, r?: Rng): string {
  const taka = Math.floor(poisha / 100);
  const rest = poisha % 100;
  if (r && rest === 0 && r() < 0.3) return String(taka);
  if (r && rest % 10 === 0 && r() < 0.3) return `${taka}.${rest / 10}`;
  return `${taka}.${String(rest).padStart(2, "0")}`;
}

/** Splits a total into AeroLink price strings: converted base + YQ + AE (2 decimals), BD whole taka. */
export function splitAmounts(r: Rng, totalMinor: number): Amounts {
  const bd = 310_500;
  const yq = int(r, 50_000, 300_000);
  const ae = int(r, 100_000, 500_000);
  const base = totalMinor - bd - yq - ae;
  if (base <= 0) throw new Error(`total ${totalMinor} too small to split`);
  return {
    base: poishaToAmount(base, r),
    taxes: [
      { code: "YQ", amount: poishaToAmount(yq, r) },
      { code: "AE", amount: poishaToAmount(ae, r) },
      { code: "BD", amount: poishaToAmount(bd, r) },
    ],
  };
}

// --- trips -----------------------------------------------------------------------------------

export function segment(
  flightNumber: string,
  origin: string,
  destination: string,
  depUtc: string,
  arrUtc: string,
  bookingClass: string,
): GenSegment {
  return { flightNumber, origin, destination, depMs: Date.parse(depUtc), arrMs: Date.parse(arrUtc), bookingClass };
}

function genJourney(r: Rng, origin: string, destination: string, day: number, cls: string, direct: boolean): GenSegment[] {
  const dep = BASE_DAY + day * DAY + int(r, 0, 287) * 5 * MINUTE;
  const flight = () => pick(r, CARRIERS) + int(r, 100, 999);
  if (direct) {
    return [{ flightNumber: flight(), origin, destination, depMs: dep, arrMs: dep + int(r, 36, 84) * 5 * MINUTE, bookingClass: cls }];
  }
  const hub = pick(r, HUBS.filter((h) => h !== origin && h !== destination));
  const arr1 = dep + int(r, 24, 60) * 5 * MINUTE;
  const dep2 = arr1 + int(r, 12, 60) * 5 * MINUTE;
  return [
    { flightNumber: flight(), origin, destination: hub, depMs: dep, arrMs: arr1, bookingClass: cls },
    { flightNumber: flight(), origin: hub, destination, depMs: dep2, arrMs: dep2 + int(r, 24, 60) * 5 * MINUTE, bookingClass: cls },
  ];
}

/** A one-way, return or multi-city trip from DAC. */
export function genTrip(r: Rng, directOnly = false): GenSegment[][] {
  const cls = pick(r, CLASSES);
  const dest = pick(r, DESTINATIONS);
  const day = int(r, 0, 59);
  const direct = () => directOnly || r() < 0.6;
  const kind = r();
  if (kind < 0.3) return [genJourney(r, "DAC", dest, day, cls, direct())];
  if (kind < 0.8) {
    return [genJourney(r, "DAC", dest, day, cls, direct()), genJourney(r, dest, "DAC", day + int(r, 3, 20), cls, direct())];
  }
  const second = pick(r, DESTINATIONS.filter((d) => d !== dest));
  return [
    genJourney(r, "DAC", dest, day, cls, direct()),
    genJourney(r, dest, second, day + int(r, 2, 6), cls, direct()),
    genJourney(r, second, "DAC", day + int(r, 8, 14), cls, direct()),
  ];
}

export interface MarketOptions {
  dupRatio?: number; // share of offers that repeat a trip already offered (by any supplier)
  ties?: boolean; // few distinct prices and durations: many ties in the ordering
  seats?: [number, number];
  refPrefix?: string;
}

/**
 * `n` offers spread over `suppliers`. A share `dupRatio` of them repeat an earlier trip, usually
 * at a different supplier. The same supplier never offers the same trip twice at the same price,
 * so the expected merge result never depends on an unstated tie rule.
 */
export function genMarket(seed: number, n: number, suppliers: number, opts: MarketOptions = {}): GenOffer[][] {
  const r = rng(seed);
  const { dupRatio = 0.25, ties = false, seats = [1, 9], refPrefix = "R" } = opts;
  const lists: GenOffer[][] = Array.from({ length: suppliers }, () => []);
  const trips: GenSegment[][][] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i++) {
    const s = Math.floor(r() * suppliers);
    let t: number;
    if (trips.length > 0 && r() < dupRatio) t = Math.floor(r() * trips.length);
    else {
      trips.push(genTrip(r, ties));
      t = trips.length - 1;
    }
    let total = ties ? (40_000 + int(r, 0, 4) * 500) * 100 : int(r, 2_000_000, 15_000_000);
    while (used.has(`${t}|${s}|${total}`)) total += 100;
    used.add(`${t}|${s}|${total}`);
    lists[s].push({
      ref: `${refPrefix}${s}-${String(lists[s].length).padStart(7, "0")}`,
      journeys: trips[t],
      seats: int(r, seats[0], seats[1]),
      totalMinor: total,
    });
  }
  return lists;
}

// --- renderers -------------------------------------------------------------------------------

function localIso(ms: number, airport: string): string {
  const off = UTC_OFFSET[airport];
  if (off === undefined) throw new Error(`no UTC offset for ${airport}`);
  const local = new Date(ms + off * MINUTE).toISOString().slice(0, 19);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function compactUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

/** Bulk fields of one offer (fare components, baggage, brands, pax breakdown), about `bytes` long. */
function bulkFields(r: Rng, bytes: number): string {
  const fare: object[] = [];
  const bags: object[] = [];
  const brands: object[] = [];
  const pax: object[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    let item: object;
    switch (i % 4) {
      case 0:
        item = { fareBasis: `${pick(r, CLASSES)}${int(r, 10, 99)}OWBD`, segment: int(r, 1, 4), filedAmount: `${int(r, 50, 2000)}.${int(r, 10, 99)}`, rule: `R${int(r, 1000, 9999)}` };
        fare.push(item);
        break;
      case 1:
        item = { segment: int(r, 1, 4), pieces: int(r, 0, 2), weightKg: int(r, 15, 40), carryOnKg: 7 };
        bags.push(item);
        break;
      case 2:
        item = { code: `B${int(r, 10, 99)}`, refundable: r() < 0.3, changeFee: `${int(r, 0, 9000)}.00`, seatChoice: r() < 0.5 };
        brands.push(item);
        break;
      default:
        item = { type: pick(r, ["ADT", "CHD", "INF"]), count: int(r, 1, 3), base: `${int(r, 100, 900)}.${int(r, 10, 99)}` };
        pax.push(item);
    }
    size += JSON.stringify(item).length + 1;
  }
  return `"fareComponents":${JSON.stringify(fare)},"baggageAllowances":${JSON.stringify(bags)},"brandAttributes":${JSON.stringify(brands)},"paxBreakdown":${JSON.stringify(pax)}`;
}

export interface AeroLinkOptions {
  seed?: number;
  bulkBytes?: number; // approximate bulk per offer
}

export function aeroLinkRaw(offers: GenOffer[], opts: AeroLinkOptions = {}): string {
  const r = rng(opts.seed ?? 7);
  const bulkBytes = opts.bulkBytes ?? 200;
  // A handful of distinct bulk blocks is enough: JSON.parse cost doesn't depend on repetition.
  const blocks = Array.from({ length: 8 }, () => bulkFields(r, bulkBytes));
  const parts = offers.map((o, i) => {
    const amounts = o.amounts ?? splitAmounts(r, o.totalMinor);
    const core = {
      offerId: o.ref,
      validatingCarrier: o.journeys[0][0].flightNumber.slice(0, 2),
      seatsLeft: o.seats,
      journeys: o.journeys.map((j) => ({
        segments: j.map((s) => ({
          carrier: s.flightNumber.slice(0, 2),
          flightNo: s.flightNumber.slice(2),
          from: s.origin,
          to: s.destination,
          dep: localIso(s.depMs, s.origin),
          arr: localIso(s.arrMs, s.destination),
          cabin: s.bookingClass === "J" || s.bookingClass === "C" ? "C" : "Y",
          rbd: s.bookingClass,
        })),
      })),
      price: { filedCurrency: pick(r, ["USD", "AED", "SGD", "MYR"]), base: amounts.base, taxes: amounts.taxes },
    };
    const json = JSON.stringify(core);
    return `${json.slice(0, -1)},${blocks[i % blocks.length]}}`;
  });
  return `{"searchId":"al-${(opts.seed ?? 7).toString(16)}","currency":"BDT","offers":[${parts.join(",")}]}`;
}

export function skyMeshRaw(offers: GenOffer[]): string {
  return JSON.stringify({
    status: "OK",
    cur: "BDT",
    fares: offers.map((o) => ({
      ref: o.ref,
      fareBasis: `${o.journeys[0][0].bookingClass}OWBD`,
      avail: o.seats,
      totalMinor: o.totalMinor,
      segs: o.journeys.flatMap((j, k) =>
        j.map((s) => [s.flightNumber, s.origin, s.destination, compactUtc(s.depMs), compactUtc(s.arrMs), s.bookingClass, k + 1].join("|")),
      ),
    })),
  });
}

export function rawFor(format: "aerolink" | "skymesh", offers: GenOffer[], opts?: AeroLinkOptions): string {
  return format === "aerolink" ? aeroLinkRaw(offers, opts) : skyMeshRaw(offers);
}

/** The Itinerary objects the service must produce for these offers (before seat filtering). */
export function toItineraries(offers: GenOffer[], supplier: string) {
  return offers.map((o) => {
    let duration = 0;
    for (const j of o.journeys) duration += (j[j.length - 1].arrMs - j[0].depMs) / MINUTE;
    return {
      id: `${supplier}:${o.ref}`,
      supplier,
      supplierRef: o.ref,
      journeys: o.journeys.map((j) => ({
        segments: j.map((s) => ({
          carrier: s.flightNumber.slice(0, 2),
          flightNumber: s.flightNumber,
          origin: s.origin,
          destination: s.destination,
          departureUtc: new Date(s.depMs).toISOString(),
          arrivalUtc: new Date(s.arrMs).toISOString(),
          bookingClass: s.bookingClass,
        })),
      })),
      totalPrice: o.amounts ? exactPoisha(o.amounts.base) + o.amounts.taxes.reduce((n, t) => n + exactPoisha(t.amount), 0) : o.totalMinor,
      seatsAvailable: o.seats,
      durationMinutes: duration,
    };
  });
}

export type ExpectedItinerary = ReturnType<typeof toItineraries>[number];

/** A request matching any generated trip (the fakes ignore the request's contents). */
export const ANY_REQUEST = {
  tripType: "return",
  legs: [
    { origin: "DAC", destination: "DXB", date: "2026-12-01" },
    { origin: "DXB", destination: "DAC", date: "2026-12-10" },
  ],
  passengers: 1,
};
