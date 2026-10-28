export type SupplierFormat = "caravel" | "tessera" | "keystone";
export type TripType = "oneway" | "return" | "multicity";
export type SortPreference = "cheapest" | "fastest" | "fewest_stops" | "preferred_airline";
export type Cabin = "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
/** Adult or child. Suppliers' own codes (CNN, CHILD, ...) are normalised to these. */
export type PaxType = "ADT" | "CHD";

/** One requested leg: airport codes ("LHR") and a local date ("YYYY-MM-DD"). */
export interface Leg {
  origin: string;
  destination: string;
  date: string;
}

/** adults 1..9, children 0..8, at most 9 in total. */
export interface Passengers {
  adults: number;
  children: number;
}

export interface SearchRequest {
  tripType: TripType;
  legs: Leg[];
  passengers: Passengers;
  preferredCarrier?: string; // 2-letter airline code; enables the "preferred_airline" sort
  sort?: SortPreference; // order of the first page; default "cheapest"
}

export interface Segment {
  marketingCarrier: string; // e.g. "XB"
  flightNumber: string; // marketing carrier + number, no leading zeros, e.g. "XB4417"
  operatingCarrier: string; // == marketingCarrier unless the flight is a codeshare
  origin: string;
  destination: string;
  departureUtc: string; // Date#toISOString()
  arrivalUtc: string; // Date#toISOString()
  bookingCode: string; // booking class (RBD), e.g. "K"
  cabin: Cabin;
  fareBasis: string;
}

/** One per requested leg, in request order. */
export interface Journey {
  segments: Segment[];
  durationMinutes: number; // last arrival - first departure
}

/** What each passenger of one type pays (base + taxes). Booking fees are not split per passenger. */
export interface PaxPrice {
  paxType: PaxType;
  count: number;
  unitTotalCents: number; // per passenger
}

export interface Itinerary {
  id: string; // `${supplier}:${supplierRef}`, the public offer id
  supplier: string; // SupplierClient.name
  supplierRef: string;
  validatingCarrier: string; // the plating carrier that issues the ticket
  brand?: string; // the supplier's fare family label, e.g. "SAVER"
  journeys: Journey[];
  totalPrice: number; // integer US cents, whole party: what the customer pays = base + taxes + fees
  baseCents: number;
  taxesCents: number;
  feesCents: number;
  prices: PaxPrice[];
  seatsAvailable: number;
  durationMinutes: number; // sum of journey durations (excludes stopovers between legs)
  stops: number; // sum over journeys of (segments - 1)
}
