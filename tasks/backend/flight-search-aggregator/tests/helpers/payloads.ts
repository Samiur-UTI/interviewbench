// Seeded generator for supplier payloads (Caravel, Tessera, Keystone).
//
// One shared "world" of flights and priced trips is packaged per supplier, so the suppliers
// really overlap: the same trip often comes back from two or three of them, at different prices.
// Every payload comes with the itineraries the service must produce for it (`expected`, before
// seat filtering), computed from the world and never from a parser: the generator is the oracle.
//
// Deterministic: mulberry32 + FNV-1a only, no Math.random or Date.now. Every time is computed in
// UTC milliseconds from fixed offsets (December dates: no airport here observes DST then).
// Each supplier draws from its own stream, so a payload doesn't depend on which others were made.
//
// Everything is invented: carriers XB/ZK/QV/MR/TJ/WL, supplier formats, flight numbers.

export type SupplierFormat = "caravel" | "tessera" | "keystone";
export type Cabin = "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";

export interface RequestLeg {
  origin: string;
  destination: string;
  date: string; // YYYY-MM-DD, local at the origin
}

export interface Passengers {
  adults: number;
  children: number;
}

export type SortPreference = "cheapest" | "fastest" | "fewest_stops" | "preferred_airline";

export interface SearchRequest {
  tripType: "oneway" | "return" | "multicity";
  legs: RequestLeg[];
  passengers: Passengers;
  preferredCarrier?: string;
  sort?: SortPreference;
}

/** The README / src/types.ts `Itinerary`, as the tests expect it. */
export interface ExpectedSegment {
  marketingCarrier: string;
  flightNumber: string;
  operatingCarrier: string;
  origin: string;
  destination: string;
  departureUtc: string;
  arrivalUtc: string;
  bookingCode: string;
  cabin: Cabin;
  fareBasis: string;
}

export interface ExpectedItinerary {
  id: string;
  supplier: string;
  supplierRef: string;
  validatingCarrier: string;
  brand?: string;
  journeys: { segments: ExpectedSegment[]; durationMinutes: number }[];
  totalPrice: number;
  baseCents: number;
  taxesCents: number;
  feesCents: number;
  prices: { paxType: "ADT" | "CHD"; count: number; unitTotalCents: number }[];
  seatsAvailable: number;
  durationMinutes: number;
  stops: number;
}

export interface Payload {
  raw: string;
  expected: ExpectedItinerary[]; // in the order the supplier lists them, before seat filtering
}

// --- randomness ------------------------------------------------------------------------------

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

/** FNV-1a: what suppliers must agree on (booking class, seats) is a hash, not a random draw. */
export function fnv1a(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const int = (r: Rng, min: number, max: number): number => min + Math.floor(r() * (max - min + 1));
const pick = <T>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)];

function shuffle<T>(r: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// --- money and time --------------------------------------------------------------------------

/** Exact cents for a supplier amount ("1037.11", "USD1037.11"), computed with BigInt. */
export function exactCents(amount: string): number {
  const m = /^(?:USD)?(\d+)\.(\d{2})$/.exec(amount);
  if (!m) throw new Error(`not an amount: ${amount}`);
  return Number(BigInt(m[1]) * 100n + BigInt(m[2]));
}

/** 140680 -> "1406.80" */
export function decimal(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** True if `Math.floor(parseFloat(amount) * 100)` loses a cent on this amount. */
export function isFloatTrap(amount: string): boolean {
  return Math.floor(parseFloat(amount) * 100) !== exactCents(amount);
}

/** UTC offset of every airport the generator uses (fixed in December). */
export const UTC_OFFSETS: Readonly<Record<string, string>> = {
  LHR: "+00:00",
  FRA: "+01:00",
  JFK: "-05:00",
  DXB: "+04:00",
  SIN: "+08:00",
  DOH: "+03:00",
  DEL: "+05:30",
  KTM: "+05:45",
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function offsetMinutes(airport: string): number {
  const off = UTC_OFFSETS[airport];
  if (off === undefined) throw new Error(`no UTC offset for ${airport}`);
  return (off[0] === "-" ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
}

/** Local date ("2026-12-02") and time ("06:15:00") of an instant at an airport. */
function local(ms: number, airport: string): { date: string; time: string } {
  const iso = new Date(ms + offsetMinutes(airport) * MINUTE).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

const utc = (ms: number): string => new Date(ms).toISOString();
const dayDiff = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

function isoDuration(minutes: number): string {
  return `PT${Math.floor(minutes / 60)}H${minutes % 60}M`;
}

// --- the world -------------------------------------------------------------------------------

export const CARRIERS = ["XB", "ZK", "QV", "MR", "TJ", "WL"] as const;
const AIRLINE_NAMES: Record<string, string> = {
  XB: "XEBEC AIR",
  ZK: "ZEPHYR KAPPA AIRWAYS",
  QV: "QUIVER AIRLINES",
  MR: "MERIDIAN REACH",
  TJ: "TERNJET",
  WL: "WILLOW AIR",
};
const HUBS = ["DOH", "DEL", "KTM", "DXB", "SIN", "FRA"];
const EQUIPMENT: Record<string, string> = { "320": "AIRBUS A320", "321": "AIRBUS A321", "359": "AIRBUS A350-900", "738": "BOEING 737-800", "789": "BOEING 787-9", "77W": "BOEING 777-300ER" };
const ECONOMY_CLASSES = ["Y", "B", "M", "H", "K", "L", "Q", "T", "V"];
const BUSINESS_CLASSES = ["J", "C", "D"];

interface Brand {
  id: string;
  code: string; // in fare basis codes
  cabin: Cabin;
  rbdFrom: number; // first booking class of the brand on its ladder
  mult: number; // fare multiplier
}

const BRANDS: readonly Brand[] = [
  { id: "SAVER", code: "SV", cabin: "ECONOMY", rbdFrom: 5, mult: 1 },
  { id: "STANDARD", code: "ST", cabin: "ECONOMY", rbdFrom: 2, mult: 1.35 },
  { id: "FLEX", code: "FX", cabin: "ECONOMY", rbdFrom: 0, mult: 1.9 },
  { id: "BUSINESS", code: "BZ", cabin: "BUSINESS", rbdFrom: 0, mult: 4.2 },
];

interface Flight {
  key: string; // unique per flight and date
  carrier: string;
  number: string; // marketing number
  opCarrier: string;
  opNumber: string;
  from: string;
  to: string;
  dep: number; // UTC ms
  arr: number;
  equipment: string;
}

/** One way to fly one requested leg. */
interface LegOption {
  flights: Flight[];
  carrier: string;
  fareLevel: number;
}

interface Candidate {
  idx: number[]; // option index per leg
  brand: Brand;
}

interface PricedSegment {
  flight: Flight;
  rbd: string;
  cabin: Cabin;
  seats: number;
}

interface PricedLeg {
  optIdx: number;
  option: LegOption;
  segments: PricedSegment[];
  adtBase: number; // cents, per adult
}

/** One sellable trip at one supplier: flights, classes and price. */
interface Sellable {
  idx: number[];
  brand: Brand;
  legs: PricedLeg[];
  adt: { base: number; tax: number }; // per passenger
  chd: { base: number; tax: number };
  fee: number; // per booking (Caravel only)
}

export interface WorldOptions {
  seed: number;
  legs?: RequestLeg[]; // default DEFAULT_LEGS
  passengers?: Passengers; // default 2 adults + 1 child
  offersPerSupplier?: number; // default 250: Caravel offers, Tessera quotes, about this many Keystone offers
  /** "dense": prices on $5 steps and times on 15-minute steps, so every sort order has many ties. Default "none". */
  tieDensity?: "none" | "dense";
  floatTraps?: boolean; // default true; false keeps every decimal amount a multiple of 25 cents
  /** Carrier mix, default CARRIERS. Each option's carrier is drawn uniformly, so repeat a code to weight it. */
  carriers?: readonly string[];
  preferredCarrier?: string; // copied into the request
  sort?: SortPreference; // copied into the request
}

export interface World {
  readonly seed: number;
  readonly request: SearchRequest;
  readonly offersPerSupplier: number;
  readonly ties: boolean;
  readonly floatTraps: boolean;
  readonly options: LegOption[][]; // per requested leg
  readonly pool: Candidate[]; // cheapest first; every supplier walks it
}

export const DEFAULT_LEGS: readonly RequestLeg[] = [
  { origin: "LHR", destination: "SIN", date: "2026-12-01" },
  { origin: "SIN", destination: "DXB", date: "2026-12-08" },
];

function tripType(legs: readonly RequestLeg[]): SearchRequest["tripType"] {
  if (legs.length === 1) return "oneway";
  const [a, b] = legs;
  return legs.length === 2 && a.origin === b.destination && a.destination === b.origin ? "return" : "multicity";
}

function buildOptions(r: Rng, legs: readonly RequestLeg[], perLeg: number, carriers: readonly string[], ties: boolean): LegOption[][] {
  const numbers = new Map<string, number>(); // next flight number per carrier
  const flightNumber = (carrier: string): number => {
    const n = (numbers.get(carrier) ?? 100) + int(r, 1, 3);
    numbers.set(carrier, n);
    return n;
  };
  const minutes = (min: number, max: number): number => (ties ? int(r, Math.ceil(min / 15), Math.floor(max / 15)) * 15 : int(r, min, max));
  return legs.map((leg) => {
    const midnight = Date.parse(`${leg.date}T00:00:00Z`) - offsetMinutes(leg.origin) * MINUTE;
    const options: LegOption[] = [];
    while (options.length < perLeg) {
      const carrier = pick(r, carriers);
      const stops = r() < 0.2 ? 0 : r() < 0.85 ? 1 : 2;
      const points = [leg.origin];
      const hubs = HUBS.filter((h) => h !== leg.origin && h !== leg.destination);
      for (let i = 0; i < stops; i++) points.push(pick(r, hubs.filter((h) => !points.includes(h))));
      points.push(leg.destination);
      let t = midnight + minutes(0, 23 * 60 + 45) * MINUTE;
      const flights: Flight[] = [];
      for (let i = 0; i + 1 < points.length; i++) {
        // About 20% are codeshares: sold under the option's carrier, operated by another one.
        const others = carriers.filter((c) => c !== carrier);
        const operator = others.length > 0 && r() < 0.2 ? pick(r, others) : carrier;
        const opNumber = flightNumber(operator);
        const number = String(operator === carrier ? opNumber : 5000 + flightNumber(carrier));
        const dep = t;
        const arr = dep + minutes(55, 480) * MINUTE;
        flights.push({
          key: `${carrier}${number}@${dep}`,
          carrier,
          number,
          opCarrier: operator,
          opNumber: String(opNumber),
          from: points[i],
          to: points[i + 1],
          dep,
          arr,
          equipment: pick(r, Object.keys(EQUIPMENT)),
        });
        t = arr + minutes(50, 600) * MINUTE;
      }
      options.push({ flights, carrier, fareLevel: int(r, 0, 5) });
    }
    return options;
  });
}

function estimate(options: LegOption[][], idx: number[], brand: Brand): number {
  return idx.reduce((t, i, li) => t + options[li][i].fareLevel * 4000 + options[li][i].flights.length * 2500, 0) * brand.mult;
}

/** Distinct (flights, brand) candidates, cheapest first: every GDS returns roughly the cheapest. */
function buildPool(r: Rng, options: LegOption[][], size: number): Candidate[] {
  const pool: (Candidate & { est: number })[] = [];
  const seen = new Set<string>();
  while (pool.length < size) {
    const idx = options.map((opts) => int(r, 0, opts.length - 1));
    const brand = BRANDS[int(r, 0, r() < 0.8 ? 2 : 3)];
    const key = `${idx.join(",")}/${brand.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({ idx, brand, est: estimate(options, idx, brand) });
  }
  pool.sort((a, b) => a.est - b.est);
  return pool.map(({ idx, brand }) => ({ idx, brand }));
}

export function createWorld(opts: WorldOptions): World {
  const legs = [...(opts.legs ?? DEFAULT_LEGS)];
  const passengers = opts.passengers ?? { adults: 2, children: 1 };
  const offersPerSupplier = opts.offersPerSupplier ?? 250;
  const ties = opts.tieDensity === "dense";
  const r = rng(opts.seed);
  const poolSize = Math.ceil(offersPerSupplier * 1.6) + 10;
  // Enough options that the pool's distinct combinations come easily.
  const perLeg = Math.max(60, Math.ceil(Math.pow(poolSize, 1 / legs.length)) + 10);
  const options = buildOptions(r, legs, perLeg, opts.carriers ?? CARRIERS, ties);
  return {
    seed: opts.seed,
    request: {
      tripType: tripType(legs),
      legs,
      passengers: { ...passengers },
      ...(opts.preferredCarrier === undefined ? {} : { preferredCarrier: opts.preferredCarrier }),
      ...(opts.sort === undefined ? {} : { sort: opts.sort }),
    },
    offersPerSupplier,
    ties,
    floatTraps: opts.floatTraps ?? true,
    options,
    pool: buildPool(r, options, poolSize),
  };
}

// --- pricing ---------------------------------------------------------------------------------

/** Rounds an amount to the world's money grid. */
function money(world: World, cents: number): number {
  const step = world.ties ? 500 : world.floatTraps ? 1 : 25;
  return Math.max(step, Math.round(cents / step) * step);
}

/** Booking class and seats on a flight for a brand, as every supplier sees it (unless stale). */
function classFor(flight: Flight, brand: Brand, drift: number): { rbd: string; seats: number } {
  const h = fnv1a(`${flight.key}/${brand.id}`);
  const ladder = brand.cabin === "BUSINESS" ? BUSINESS_CLASSES : ECONOMY_CLASSES;
  return { rbd: ladder[Math.min(ladder.length - 1, brand.rbdFrom + (h % 3) + drift)], seats: 1 + ((h >>> 3) % 9) };
}

/**
 * Prices one candidate at one supplier. About 5% of a supplier's segments show one class lower
 * (stale availability), which makes near-duplicates that must not merge.
 */
function price(world: World, r: Rng, idx: number[], brand: Brand): Sellable {
  const legs = idx.map((i, li): PricedLeg => {
    const option = world.options[li][i];
    const segments = option.flights.map((flight) => ({ flight, cabin: brand.cabin, ...classFor(flight, brand, r() < 0.05 ? 1 : 0) }));
    const base = Math.round((9000 + option.fareLevel * 4000 + option.flights.length * 2500) * brand.mult);
    return { optIdx: i, option, segments, adtBase: money(world, base + (fnv1a(`${option.carrier}${option.fareLevel}${brand.id}${li}`) % 100)) };
  });
  const th = fnv1a(idx.join(","));
  const adtTax = money(world, 6000 + (th % 5000));
  const chdTax = money(world, adtTax - 500 - ((th >>> 7) % 1500));
  const adtBase = legs.reduce((t, l) => t + l.adtBase, 0);
  const chdBase = legs.reduce((t, l) => t + money(world, Math.round(l.adtBase * 0.75)), 0);
  return { idx, brand, legs, adt: { base: adtBase, tax: adtTax }, chd: { base: chdBase, tax: chdTax }, fee: r() < 0.15 ? money(world, int(r, 100, 900)) : 0 };
}

interface Totals {
  adtTotal: number; // per adult
  chdTotal: number; // per child
  base: number; // whole party
  tax: number;
  total: number; // whole party, without fees
}

function totals(world: World, s: Sellable): Totals {
  const { adults, children } = world.request.passengers;
  const adtTotal = s.adt.base + s.adt.tax;
  const chdTotal = s.chd.base + s.chd.tax;
  return {
    adtTotal,
    chdTotal,
    base: adults * s.adt.base + children * s.chd.base,
    tax: adults * s.adt.tax + children * s.chd.tax,
    total: adults * adtTotal + children * chdTotal,
  };
}

function fareBasis(leg: PricedLeg, brand: Brand): string {
  return `${leg.segments[0].rbd}${brand.code}XW`;
}

function paxPrices(world: World, t: Totals): ExpectedItinerary["prices"] {
  const { adults, children } = world.request.passengers;
  const prices: ExpectedItinerary["prices"] = [{ paxType: "ADT", count: adults, unitTotalCents: t.adtTotal }];
  if (children > 0) prices.push({ paxType: "CHD", count: children, unitTotalCents: t.chdTotal });
  return prices;
}

function expectedSegment(seg: PricedSegment, basis: string, shiftMs = 0): ExpectedSegment {
  const f = seg.flight;
  return {
    marketingCarrier: f.carrier,
    flightNumber: f.carrier + f.number,
    operatingCarrier: f.opCarrier,
    origin: f.from,
    destination: f.to,
    departureUtc: utc(f.dep + shiftMs),
    arrivalUtc: utc(f.arr + shiftMs),
    bookingCode: seg.rbd,
    cabin: seg.cabin,
    fareBasis: basis,
  };
}

function expectedItinerary(
  supplier: string,
  supplierRef: string,
  journeys: ExpectedSegment[][],
  rest: Omit<ExpectedItinerary, "id" | "supplier" | "supplierRef" | "journeys" | "durationMinutes" | "stops">,
): ExpectedItinerary {
  const js = journeys.map((segments) => ({
    segments,
    durationMinutes: (Date.parse(segments[segments.length - 1].arrivalUtc) - Date.parse(segments[0].departureUtc)) / MINUTE,
  }));
  return {
    id: `${supplier}:${supplierRef}`,
    supplier,
    supplierRef,
    journeys: js,
    ...rest,
    durationMinutes: js.reduce((t, j) => t + j.durationMinutes, 0),
    stops: js.reduce((t, j) => t + j.segments.length - 1, 0),
  };
}

/** The supplier's share of the pool: it keeps about 70% of it, cheapest first. */
function* walkPool(world: World, r: Rng): Generator<Candidate> {
  for (const c of world.pool) if (r() < 0.7) yield c;
}

// --- Caravel ---------------------------------------------------------------------------------

const AMENITIES = [
  { description: "PRE RESERVED SEAT ASSIGNMENT", isChargeable: false, amenityType: "PRE_RESERVED_SEAT", amenityProvider: { name: "BrandedFares" } },
  { description: "FIRST CHECKED BAG UP TO 23KG 50LB", isChargeable: false, amenityType: "BAGGAGE", amenityProvider: { name: "BrandedFares" } },
  { description: "SECOND CHECKED BAG UP TO 23KG 50LB", isChargeable: true, amenityType: "BAGGAGE", amenityProvider: { name: "BrandedFares" } },
  { description: "CARRY ON HAND BAGGAGE UP TO 7KG", isChargeable: false, amenityType: "BAGGAGE", amenityProvider: { name: "BrandedFares" } },
  { description: "COMPLIMENTARY MEAL AND BEVERAGE", isChargeable: false, amenityType: "MEAL", amenityProvider: { name: "BrandedFares" } },
  { description: "CHANGEABLE TICKET WITH FEE BEFORE DEPARTURE", isChargeable: true, amenityType: "BRANDED_FARES", amenityProvider: { name: "BrandedFares" } },
  { description: "REFUNDABLE TICKET WITH FEE BEFORE DEPARTURE", isChargeable: true, amenityType: "BRANDED_FARES", amenityProvider: { name: "BrandedFares" } },
  { description: "PRIORITY CHECK IN AND BOARDING", isChargeable: true, amenityType: "TRAVEL_SERVICES", amenityProvider: { name: "BrandedFares" } },
  { description: "LOUNGE ACCESS AT DEPARTURE AIRPORT", isChargeable: true, amenityType: "TRAVEL_SERVICES", amenityProvider: { name: "BrandedFares" } },
  { description: "EARN MILES ON THIS FARE 100 PERCENT", isChargeable: false, amenityType: "BRANDED_FARES", amenityProvider: { name: "BrandedFares" } },
  { description: "IN FLIGHT ENTERTAINMENT ON DEMAND", isChargeable: false, amenityType: "ENTERTAINMENT", amenityProvider: { name: "BrandedFares" } },
  { description: "WIFI MESSAGING PACKAGE", isChargeable: true, amenityType: "ENTERTAINMENT", amenityProvider: { name: "BrandedFares" } },
];

export interface CaravelOptions {
  supplier?: string; // client name used in the expected ids; default "caravel"
  amenities?: number; // amenity objects per traveller per segment fare (bulk the service ignores); default 0
}

export function caravelPayload(world: World, opts: CaravelOptions = {}): Payload {
  const supplier = opts.supplier ?? "caravel";
  const r = rng(fnv1a(`${world.seed}:caravel`));
  const { adults, children } = world.request.passengers;
  const amenities = Array.from({ length: opts.amenities ?? 0 }, (_, i) => AMENITIES[i % AMENITIES.length]);
  const airports = new Set<string>();
  const airlines = new Set<string>();
  const equipment = new Set<string>();
  const offers: object[] = [];
  const expected: ExpectedItinerary[] = [];

  for (const c of walkPool(world, r)) {
    if (offers.length >= world.offersPerSupplier) break;
    const s = price(world, r, c.idx, c.brand);
    const t = totals(world, s);
    const offerId = String(offers.length + 1);
    // segRefs are unique within the offer only, and don't always start at 1.
    let ref = r() < 0.2 ? int(r, 2, 9) : 0;
    const fares: object[] = [];
    const journeys = s.legs.map((leg) => {
      const basis = fareBasis(leg, s.brand);
      const segments = leg.segments.map((seg) => {
        const f = seg.flight;
        const segRef = String(++ref);
        airports.add(f.from).add(f.to);
        airlines.add(f.carrier).add(f.opCarrier);
        equipment.add(f.equipment);
        fares.push({ segRef, cabin: seg.cabin, fareBasis: basis, brand: s.brand.id, rbd: seg.rbd, checkedBags: { pieces: s.brand.id === "SAVER" ? 1 : 2 } });
        const d = local(f.dep, f.from);
        const a = local(f.arr, f.to);
        return {
          segRef,
          board: { airport: f.from, terminal: "1", localTime: `${d.date}T${d.time}` },
          alight: { airport: f.to, terminal: "1", localTime: `${a.date}T${a.time}` },
          airline: f.carrier,
          flightNo: f.number,
          equipment: { type: f.equipment },
          operatedBy: { airline: f.opCarrier },
          blockTime: isoDuration((f.arr - f.dep) / MINUTE),
          stopCount: 0,
        };
      });
      const first = leg.segments[0].flight;
      const last = leg.segments[leg.segments.length - 1].flight;
      return { elapsed: isoDuration((last.arr - first.dep) / MINUTE), segments };
    });
    // About 10% of offers list their segment fares out of segment order.
    if (r() < 0.1) shuffle(r, fares);
    const segmentFares = (child: boolean) =>
      fares.map((f) => ({ ...f, ...(child ? { fareBasis: `${(f as { fareBasis: string }).fareBasis}CH` } : {}), ...(amenities.length ? { amenities } : {}) }));
    const travellerPricing: object[] = [];
    for (let k = 0; k < adults; k++) {
      travellerPricing.push({ travellerId: String(travellerPricing.length + 1), fareOption: "STANDARD", paxType: "ADULT", price: { currency: "USD", total: decimal(t.adtTotal), base: decimal(s.adt.base) }, segmentFares: segmentFares(false) });
    }
    for (let k = 0; k < children; k++) {
      travellerPricing.push({ travellerId: String(travellerPricing.length + 1), fareOption: "STANDARD", paxType: "CHILD", price: { currency: "USD", total: decimal(t.chdTotal), base: decimal(s.chd.base) }, segmentFares: segmentFares(true) });
    }
    const seats = Math.min(...s.legs.flatMap((l) => l.segments.map((g) => g.seats)));
    offers.push({
      type: "fare-offer",
      offerId,
      channel: "GDS",
      oneWayCombinable: false,
      lastTicketingDate: "2026-11-24",
      seatsBookable: seats,
      journeys,
      fare: {
        currency: "USD",
        total: decimal(t.total),
        base: decimal(t.base),
        fees: [{ amount: "0.00", kind: "SUPPLIER" }, { amount: decimal(s.fee), kind: "TICKETING" }],
        grandTotal: decimal(t.total + s.fee),
      },
      pricingFlags: { fareType: ["PUBLISHED"], includedBagsOnly: false },
      validatingAirlines: [s.legs[0].option.carrier],
      travellerPricing,
    });
    expected.push(
      expectedItinerary(
        supplier,
        offerId,
        s.legs.map((leg) => leg.segments.map((seg) => expectedSegment(seg, fareBasis(leg, s.brand)))),
        {
          validatingCarrier: s.legs[0].option.carrier,
          brand: s.brand.id,
          totalPrice: t.total + s.fee,
          baseCents: t.base,
          taxesCents: t.tax,
          feesCents: s.fee,
          prices: paxPrices(world, t),
          seatsAvailable: seats,
        },
      ),
    );
  }
  const doc = {
    meta: { resultCount: offers.length, currency: "USD", searchId: `cv-${world.seed.toString(16)}` },
    offers,
    lookups: {
      airports: Object.fromEntries([...airports].sort().map((code) => [code, { city: code, country: "ZZ", utcOffset: UTC_OFFSETS[code] }])),
      airlines: Object.fromEntries([...airlines].sort().map((code) => [code, AIRLINE_NAMES[code] ?? `${code} AIRWAYS`])),
      equipment: Object.fromEntries([...equipment].sort().map((code) => [code, EQUIPMENT[code]])),
    },
  };
  return { raw: JSON.stringify(doc), expected };
}

// --- Tessera ---------------------------------------------------------------------------------

export interface TesseraOptions {
  supplier?: string; // default "tessera"
  /**
   * Alternate-date search: one group per shift, every requested date moved by that many days.
   * Default [0]. The groups share the schedule and leg tables (schedules carry no date).
   */
  alternateDayShifts?: number[];
}

/** A row of a Tessera description table, or of a Keystone keyed list. */
type TableRow = { id: number; [field: string]: unknown };
type KeyedRow = { key: string; [field: string]: unknown };

const CABIN_CODES: Record<Cabin, string> = { ECONOMY: "Y", PREMIUM_ECONOMY: "S", BUSINESS: "C", FIRST: "F" };

export function tesseraPayload(world: World, opts: TesseraOptions = {}): Payload {
  const supplier = opts.supplier ?? "tessera";
  const shifts = opts.alternateDayShifts ?? [0];
  const r = rng(fnv1a(`${world.seed}:tessera`));
  const req = world.request;
  const { adults, children } = req.passengers;
  const sparse = () => 1 + int(r, 0, 2);

  // Quotes per flight combination: each kept candidate, often with one or two other brands.
  const byTrip = new Map<string, Sellable[]>();
  let quotes = 0;
  for (const c of walkPool(world, r)) {
    if (quotes >= world.offersPerSupplier) break;
    const key = c.idx.join(",");
    const list = byTrip.get(key) ?? [];
    if (list.some((s) => s.brand === c.brand)) continue;
    const brands = [c.brand, ...shuffle(r, BRANDS.filter((b) => b !== c.brand)).slice(0, r() < 0.6 ? int(r, 1, 2) : 0)];
    for (const brand of brands) {
      if (quotes >= world.offersPerSupplier || list.some((s) => s.brand === brand)) continue;
      list.push(price(world, r, c.idx, brand));
      quotes++;
    }
    byTrip.set(key, list);
  }

  const schedules = new Map<string, TableRow>();
  let scheduleId = 0;
  const scheduleRef = (f: Flight): number => {
    let row = schedules.get(f.key);
    if (!row) {
      const d = local(f.dep, f.from);
      const a = local(f.arr, f.to);
      const dayOffset = dayDiff(d.date, a.date);
      row = {
        id: (scheduleId += sparse()),
        stops: 0,
        eTicketable: true,
        elapsedMinutes: (f.arr - f.dep) / MINUTE,
        departure: { airport: f.from, country: "ZZ", time: d.time + UTC_OFFSETS[f.from], terminal: "1" },
        arrival: { airport: f.to, country: "ZZ", time: a.time + UTC_OFFSETS[f.to], terminal: "1", ...(dayOffset ? { dayOffset } : {}) },
        carrier: {
          marketing: f.carrier,
          marketingFlightNumber: Number(f.number),
          operating: f.opCarrier,
          operatingFlightNumber: Number(f.opNumber),
          ...(f.opCarrier !== f.carrier ? { codeShared: AIRLINE_NAMES[f.opCarrier] ?? f.opCarrier } : {}),
          equipment: { code: f.equipment },
        },
      };
      schedules.set(f.key, row);
    }
    return row.id;
  };
  const legRows = new Map<string, TableRow>();
  let legId = 0;
  const legRef = (leg: PricedLeg, li: number): number => {
    const key = `${li}:${leg.optIdx}`;
    let row = legRows.get(key);
    if (!row) {
      const flights = leg.option.flights;
      row = {
        id: (legId += sparse()),
        elapsedMinutes: (flights[flights.length - 1].arr - flights[0].dep) / MINUTE,
        schedules: flights.map((f) => {
          const offset = dayDiff(req.legs[li].date, local(f.dep, f.from).date);
          return offset ? { ref: scheduleRef(f), departureDayOffset: offset } : { ref: scheduleRef(f) };
        }),
      };
      legRows.set(key, row);
    }
    return row.id;
  };
  const fareComponents = new Map<string, TableRow>();
  let fcId = 10;
  const fcRef = (basis: string, paxType: string, amount: number, carrier: string, from: string, to: string): number => {
    const key = [basis, paxType, amount, carrier, from, to].join("/");
    let row = fareComponents.get(key);
    if (!row) {
      row = { id: (fcId += sparse()), governingCarrier: carrier, fareBasis: basis, paxType, fareAmountCents: amount, startAirport: from, endAirport: to, direction: "EH" };
      fareComponents.set(key, row);
    }
    return row.id;
  };
  const taxes = new Map<string, number>();
  const taxRef = (code: string, amount: number): number => {
    const key = `${code}${amount}`;
    if (!taxes.has(key)) taxes.set(key, taxes.size + 1);
    return taxes.get(key) as number;
  };

  interface Quote {
    s: Sellable;
    t: Totals;
    span: boolean; // one fare component over every flight of every leg
    json: object;
  }
  const trips = [...byTrip.values()].map((sellables) => {
    const legRefs = sellables[0].legs.map((leg, li) => ({ ref: legRef(leg, li) }));
    const quoteList: Quote[] = sellables.map((s) => {
      const t = totals(world, s);
      const span = s.legs.length > 1 && r() < 0.1;
      const segment = (seg: PricedSegment) => ({ segment: { bookingCode: seg.rbd, cabinCode: CABIN_CODES[seg.cabin], seatsAvailable: seg.seats } });
      const paxQuote = (paxType: "ADT" | "CNN", paxCount: number, base: number, tax: number, total: number) => {
        const child = paxType === "CNN" ? "CH" : "";
        const carrier = s.legs[0].option.carrier;
        const components = span
          ? [
              {
                ref: fcRef(`${s.legs[0].segments[0].rbd}STPXW${child}`, paxType, base, carrier, req.legs[0].origin, req.legs[req.legs.length - 1].destination),
                segments: s.legs.flatMap((l) => l.segments.map(segment)),
              },
            ]
          : s.legs.map((l) => ({
              ref: fcRef(fareBasis(l, s.brand) + child, paxType, child ? money(world, Math.round(l.adtBase * 0.75)) : l.adtBase, l.option.carrier, l.option.flights[0].from, l.option.flights[l.option.flights.length - 1].to),
              segments: l.segments.map(segment),
            }));
        return {
          paxQuote: {
            paxType,
            paxCount,
            nonRefundable: s.brand.id === "SAVER",
            fareComponents: components,
            taxes: [{ ref: taxRef("YQ", tax - Math.min(tax, 3000)) }, { ref: taxRef("AE", Math.min(tax, 3000)) }],
            perPaxTotal: { totalCents: total, baseCents: base, taxCents: tax, currency: "USD" },
          },
        };
      };
      const paxQuotes = [paxQuote("ADT", adults, s.adt.base, s.adt.tax, t.adtTotal)];
      if (children > 0) paxQuotes.push(paxQuote("CNN", children, s.chd.base, s.chd.tax, t.chdTotal));
      const json = {
        brandId: s.brand.id,
        fare: {
          validatingCarrier: s.legs[0].option.carrier,
          eTicketable: true,
          lastTicketDate: "2026-11-24",
          paxQuotes,
          totalFare: { totalCents: t.total, baseCents: t.base, taxCents: t.tax, currency: "USD" },
        },
      };
      return { s, t, span, json };
    });
    return { legRefs, quotes: quoteList };
  });

  const expected: ExpectedItinerary[] = [];
  let itineraryId = 0;
  const groups = shifts.map((shift) => ({
    header: { slices: req.legs.map((l) => ({ date: shiftDate(l.date, shift), from: l.origin, to: l.destination })) },
    itineraries: trips.map((trip) => {
      const id = ++itineraryId;
      trip.quotes.forEach((q, qi) => {
        const spanBasis = `${q.s.legs[0].segments[0].rbd}STPXW`;
        expected.push(
          expectedItinerary(
            supplier,
            `${id}.${qi + 1}`,
            q.s.legs.map((leg) => leg.segments.map((seg) => expectedSegment(seg, q.span ? spanBasis : fareBasis(leg, q.s.brand), shift * DAY))),
            {
              validatingCarrier: q.s.legs[0].option.carrier,
              brand: q.s.brand.id,
              totalPrice: q.t.total,
              baseCents: q.t.base,
              taxesCents: q.t.tax,
              feesCents: 0,
              prices: paxPrices(world, q.t),
              seatsAvailable: Math.min(...q.s.legs.flatMap((l) => l.segments.map((g) => g.seats))),
            },
          ),
        );
      });
      return { id, source: "ADVJR1", legs: trip.legRefs, quotes: trip.quotes.map((q) => q.json) };
    }),
  }));

  const doc = {
    shopResponse: {
      version: "6.4.0",
      messages: [{ severity: "Info", type: "SERVER", code: "TRANSACTIONID", text: `tx-${world.seed.toString(16)}` }],
      statistics: { itineraryCount: itineraryId },
      scheduleTable: shuffle(r, [...schedules.values()]),
      taxTable: [...taxes.entries()].map(([key, id]) => ({ id, code: key.slice(0, 2), amountCents: Number(key.slice(2)), currency: "USD" })),
      fareComponentTable: shuffle(r, [...fareComponents.values()]),
      legTable: shuffle(r, [...legRows.values()]),
      groups,
    },
  };
  return { raw: JSON.stringify(doc), expected };
}

function shiftDate(date: string, days: number): string {
  return utc(Date.parse(`${date}T00:00:00Z`) + days * DAY).slice(0, 10);
}

// --- Keystone --------------------------------------------------------------------------------

export interface KeystoneOptions {
  supplier?: string; // default "keystone"
}

/** XML->JSON: a single child becomes a bare object. */
const one = <T>(items: T[]): T | T[] => (items.length === 1 ? items[0] : items);

export function keystonePayload(world: World, opts: KeystoneOptions = {}): Payload {
  const supplier = opts.supplier ?? "keystone";
  const r = rng(fnv1a(`${world.seed}:keystone`));
  const req = world.request;
  const { adults, children } = req.passengers;
  let serial = 0;
  // Opaque keys in the style of base64 ids: they contain "+", "/" and "=".
  const key = (): string => {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32BE(++serial, 0);
    bytes.writeUInt32BE(Math.floor(r() * 4294967296), 4);
    return bytes.toString("base64");
  };
  const segments = new Map<string, KeyedRow>();
  const segmentRef = (f: Flight, li: number): string => {
    let row = segments.get(f.key);
    if (!row) {
      row = {
        key: key(),
        group: li,
        carrier: f.carrier,
        flightNumber: f.number,
        origin: f.from,
        destination: f.to,
        departs: `${local(f.dep, f.from).date}T${local(f.dep, f.from).time}.000${UTC_OFFSETS[f.from]}`,
        arrives: `${local(f.arr, f.to).date}T${local(f.arr, f.to).time}.000${UTC_OFFSETS[f.to]}`,
        flightTime: (f.arr - f.dep) / MINUTE,
        equipment: f.equipment,
        changeOfPlane: false,
        ...(f.opCarrier !== f.carrier ? { codeshareInfo: { operatingCarrier: f.opCarrier, operatingFlightNumber: f.opNumber, "#text": AIRLINE_NAMES[f.opCarrier] ?? f.opCarrier } } : {}),
      };
      segments.set(f.key, row);
    }
    return row.key;
  };
  const fareInfos = new Map<string, KeyedRow>();
  const fareInfoRef = (basis: string, paxType: string, li: number, amount: number, brand: Brand): string => {
    const k = [basis, paxType, li, amount].join("/");
    let row = fareInfos.get(k);
    if (!row) {
      const leg = req.legs[li];
      row = { key: key(), fareBasis: basis, paxType, origin: leg.origin, destination: leg.destination, departureDate: leg.date, amount: `USD${decimal(amount)}`, brand: { name: brand.id } };
      fareInfos.set(k, row);
    }
    return row.key;
  };
  const legKeys = req.legs.map(() => key());

  const pricePoints: object[] = [];
  const expected: ExpectedItinerary[] = [];
  for (const c of walkPool(world, r)) {
    if (expected.length >= world.offersPerSupplier) break;
    const s = price(world, r, c.idx, c.brand);
    const t = totals(world, s);
    // Per leg: the candidate's flights plus up to 3 more by the same carrier with as many stops,
    // all sold on the same fare in the same booking classes.
    const perLeg = s.legs.map((leg, li) => {
      const similar = world.options[li]
        .map((o, i) => ({ o, i }))
        .filter(({ o, i }) => i !== leg.optIdx && o.carrier === leg.option.carrier && o.flights.length === leg.option.flights.length);
      const extra = shuffle(r, similar).slice(0, int(r, 0, 3));
      return [
        leg.segments,
        ...extra.map(({ o }) => o.flights.map((flight, k): PricedSegment => ({ flight, rbd: leg.segments[k].rbd, cabin: s.brand.cabin, seats: classFor(flight, s.brand, 0).seats }))),
      ];
    });
    const pointKey = key();
    const pricingInfo = (paxType: "ADT" | "CNN", count: number, base: number, tax: number, unit: number) => {
      const child = paxType === "CNN" ? "CH" : "";
      const fares = s.legs.map((leg, li) => fareInfoRef(fareBasis(leg, s.brand) + child, paxType, li, child ? money(world, Math.round(leg.adtBase * 0.75)) : leg.adtBase, s.brand));
      const optionKeys = perLeg.map((options) => options.map(() => key()));
      return {
        optionKeys,
        json: {
          key: key(),
          platingCarrier: s.legs[0].option.carrier,
          totalPrice: `USD${decimal(unit * count)}`,
          basePrice: `USD${decimal(base * count)}`,
          taxes: `USD${decimal(tax * count)}`,
          refundable: s.brand.id !== "SAVER",
          latestTicketingTime: "2026-11-24T23:59:00.000+00:00",
          fareInfoRef: one(fares.map((k) => ({ key: k }))),
          passengerType: one(Array.from({ length: count }, () => ({ code: paxType }))),
          flightOptions: {
            flightOption: one(
              perLeg.map((options, li) => ({
                legRef: legKeys[li],
                origin: req.legs[li].origin,
                destination: req.legs[li].destination,
                option: one(
                  options.map((segs, oi) => {
                    const first = segs[0].flight;
                    const last = segs[segs.length - 1].flight;
                    const minutes = (last.arr - first.dep) / MINUTE;
                    const bookingInfo = segs.map((seg) => ({ bookingCode: seg.rbd, bookingCount: seg.seats, cabinClass: seg.cabin === "BUSINESS" ? "Business" : "Economy", fareInfoRef: fares[li], segmentRef: segmentRef(seg.flight, li) }));
                    return {
                      key: optionKeys[li][oi],
                      travelTime: `P${Math.floor(minutes / 1440)}DT${Math.floor((minutes % 1440) / 60)}H${minutes % 60}M0S`,
                      bookingInfo: one(bookingInfo),
                      ...(segs.length > 1 ? { connection: one(segs.slice(1).map((_, k) => ({ segmentIndex: k }))) } : {}),
                    };
                  }),
                ),
              })),
            ),
          },
        },
      };
    };
    const adt = pricingInfo("ADT", adults, s.adt.base, s.adt.tax, t.adtTotal);
    const infos = [adt.json];
    if (children > 0) infos.push(pricingInfo("CNN", children, s.chd.base, s.chd.tax, t.chdTotal).json);
    pricePoints.push({ key: pointKey, totalPrice: `USD${decimal(t.total)}`, basePrice: `USD${decimal(t.base)}`, taxes: `USD${decimal(t.tax)}`, completeItinerary: true, pricingInfo: one(infos) });

    // Every combination of one option per leg is an offer, in cartesian order.
    const combos = perLeg.reduce<number[][]>((acc, options) => acc.flatMap((combo) => options.map((_, oi) => [...combo, oi])), [[]]);
    for (const combo of combos) {
      const chosen = combo.map((oi, li) => perLeg[li][oi]);
      expected.push(
        expectedItinerary(
          supplier,
          [pointKey, ...combo.map((oi, li) => adt.optionKeys[li][oi])].join("|"),
          chosen.map((segs, li) => segs.map((seg) => expectedSegment(seg, fareBasis(s.legs[li], s.brand)))),
          {
            validatingCarrier: s.legs[0].option.carrier,
            brand: s.brand.id,
            totalPrice: t.total,
            baseCents: t.base,
            taxesCents: t.tax,
            feesCents: 0,
            prices: paxPrices(world, t),
            seatsAvailable: Math.min(...chosen.flat().map((seg) => seg.seats)),
          },
        ),
      );
    }
  }
  const doc = {
    searchRsp: {
      traceId: `ks-${world.seed.toString(16)}`,
      responseTimeMs: 2140,
      currency: "USD",
      segmentIndex: { seg: one([...segments.values()]) },
      fareInfoIndex: { fareInfo: one([...fareInfos.values()]) },
      routeIndex: { route: { key: key(), leg: one(req.legs.map((l, i) => ({ key: legKeys[i], group: i, origin: l.origin, destination: l.destination }))) } },
      pricePoints: { pricePoint: one(pricePoints) },
    },
  };
  return { raw: JSON.stringify(doc), expected };
}

// --- all three ------------------------------------------------------------------------------

export interface SearchOptions extends WorldOptions {
  amenities?: number; // Caravel bulk, see CaravelOptions
  alternateDayShifts?: number[]; // Tessera groups, see TesseraOptions
}

export interface GeneratedSupplier extends Payload {
  name: string; // client name; the expected ids use it
  format: SupplierFormat;
  itineraries: ExpectedItinerary[]; // = expected
}

export interface GeneratedSearch {
  world: World;
  request: SearchRequest;
  suppliers: GeneratedSupplier[]; // caravel, tessera, keystone: the preference order
}

/** One world, packaged by all three suppliers. Client names equal the format names. */
export function generateSearch(opts: SearchOptions): GeneratedSearch {
  const world = createWorld(opts);
  const supplier = (format: SupplierFormat, payload: Payload): GeneratedSupplier => ({ name: format, format, ...payload, itineraries: payload.expected });
  return {
    world,
    request: world.request,
    suppliers: [
      supplier("caravel", caravelPayload(world, { amenities: opts.amenities })),
      supplier("tessera", tesseraPayload(world, { alternateDayShifts: opts.alternateDayShifts })),
      supplier("keystone", keystonePayload(world)),
    ],
  };
}

// --- shared reference rules ------------------------------------------------------------------

/** README rule 3, exactly as stored in `offers.trip_key`. */
export function tripKey(it: Pick<ExpectedItinerary, "journeys">): string {
  return it.journeys
    .map((j) => j.segments.map((s) => `${s.flightNumber}@${s.departureUtc}:${s.origin}-${s.destination}/${s.bookingCode}/${s.cabin}`).join(","))
    .join("|");
}
