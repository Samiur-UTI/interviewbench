// Normalised itineraries (README / src/types.ts shape) built directly, without a supplier payload.
// For tests of the persistence and paging layer only; supplier tests use payloads.ts.

export interface TestSegment {
  marketingCarrier: string;
  flightNumber: string;
  operatingCarrier: string;
  origin: string;
  destination: string;
  departureUtc: string;
  arrivalUtc: string;
  bookingCode: string;
  cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  fareBasis: string;
}

export interface TestItinerary {
  id: string;
  supplier: string;
  supplierRef: string;
  validatingCarrier: string;
  brand?: string;
  journeys: { segments: TestSegment[]; durationMinutes: number }[];
  totalPrice: number;
  baseCents: number;
  taxesCents: number;
  feesCents: number;
  prices: { paxType: "ADT" | "CHD"; count: number; unitTotalCents: number }[];
  seatsAvailable: number;
  durationMinutes: number;
  stops: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CARRIERS = ["XB", "ZK", "QV", "MR", "TJ", "WL"];
const HUBS = ["DOH", "DEL", "KTM", "DXB"];

/**
 * `count` itineraries for a 2-leg LHR-SIN / SIN-LHR search (2 adults + 1 child) from one
 * supplier. Prices snap to $5 and durations to 15 minutes, so every sort has many ties.
 */
export function makeItineraries(supplier: string, count: number, seed: number): TestItinerary[] {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const out: TestItinerary[] = [];
  for (let n = 0; n < count; n++) {
    const carrier = pick(CARRIERS);
    const journeys = [
      ["LHR", "SIN", Date.UTC(2026, 11, 1)],
      ["SIN", "LHR", Date.UTC(2026, 11, 8)],
    ].map(([from, to, day]) => {
      const stops = int(0, 2);
      const points = [from as string, ...Array.from({ length: stops }, (_, i) => HUBS[(i + n) % HUBS.length]), to as string];
      let t = (day as number) + int(0, 95) * 15 * 60_000;
      const segments: TestSegment[] = [];
      for (let i = 0; i + 1 < points.length; i++) {
        const dep = t;
        const arr = dep + int(4, 30) * 15 * 60_000;
        const business = rnd() < 0.15;
        segments.push({
          marketingCarrier: carrier,
          flightNumber: `${carrier}${int(100, 9999)}`,
          operatingCarrier: rnd() < 0.2 ? pick(CARRIERS) : carrier,
          origin: points[i],
          destination: points[i + 1],
          departureUtc: new Date(dep).toISOString(),
          arrivalUtc: new Date(arr).toISOString(),
          bookingCode: business ? pick(["J", "C"]) : pick(["Y", "K", "L", "Q"]),
          cabin: business ? "BUSINESS" : "ECONOMY",
          fareBasis: `${business ? "J" : "K"}${int(10, 99)}GB`,
        });
        t = arr + int(4, 24) * 15 * 60_000;
      }
      const first = Date.parse(segments[0].departureUtc);
      const last = Date.parse(segments[segments.length - 1].arrivalUtc);
      return { segments, durationMinutes: (last - first) / 60_000 };
    });
    const adt = int(60, 400) * 500;
    const chd = int(40, 300) * 500;
    const feesCents = rnd() < 0.3 ? 1500 : 0;
    const totalPrice = 2 * adt + chd;
    const taxesCents = Math.floor(totalPrice / 5);
    const ref = `R${String(seed).padStart(3, "0")}-${String(n).padStart(5, "0")}`;
    const it: TestItinerary = {
      id: `${supplier}:${ref}`,
      supplier,
      supplierRef: ref,
      validatingCarrier: carrier,
      journeys,
      totalPrice,
      baseCents: totalPrice - taxesCents - feesCents,
      taxesCents,
      feesCents,
      prices: [
        { paxType: "ADT", count: 2, unitTotalCents: adt },
        { paxType: "CHD", count: 1, unitTotalCents: chd },
      ],
      seatsAvailable: int(1, 9),
      durationMinutes: journeys.reduce((sum, j) => sum + j.durationMinutes, 0),
      stops: journeys.reduce((sum, j) => sum + j.segments.length - 1, 0),
    };
    if (rnd() < 0.6) it.brand = pick(["SAVER", "STANDARD", "FLEX"]);
    out.push(it);
  }
  return out;
}
