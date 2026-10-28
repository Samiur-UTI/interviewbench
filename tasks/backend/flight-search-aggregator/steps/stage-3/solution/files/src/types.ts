export type SupplierFormat = "aerolink" | "skymesh";
export type TripType = "oneway" | "return" | "multicity";

/** One requested leg: airport codes ("DAC") and a local date ("YYYY-MM-DD"). */
export interface Leg {
  origin: string;
  destination: string;
  date: string;
}

export interface SearchRequest {
  tripType: TripType;
  legs: Leg[];
  passengers: number;
}

export interface Segment {
  carrier: string; // e.g. "XB"
  flightNumber: string; // carrier + number, e.g. "XB581"
  origin: string;
  destination: string;
  departureUtc: string; // Date#toISOString()
  arrivalUtc: string; // Date#toISOString()
  bookingClass: string; // e.g. "K" economy, "J" business
}

export interface Journey {
  segments: Segment[];
}

export interface Itinerary {
  id: string; // `${supplier}:${supplierRef}`
  supplier: string; // SupplierClient.name
  supplierRef: string;
  journeys: Journey[];
  totalPrice: number; // integer poisha (BDT), all passengers, all taxes
  seatsAvailable: number;
  durationMinutes: number; // sum over journeys of (last arrival - first departure)
}

export interface SupplierStatus {
  supplier: string; // SupplierClient.name
  status: "ok" | "error" | "timeout";
  offers: number; // itineraries parsed from this supplier, before seat filtering and de-duplication
  error?: string; // short message when status is "error"
}

export interface SearchResult {
  itineraries: Itinerary[];
  partial: boolean; // true if any supplier is not "ok"
  suppliers: SupplierStatus[]; // one per client, in client order
}

export interface SearchOptions {
  timeoutMs?: number; // deadline for the whole fan-out, integer 1..30000
  signal?: AbortSignal; // aborts when the caller gives up
}

export interface ServiceOptions {
  defaultTimeoutMs?: number; // default 8000
  parserThreads?: number; // integer >= 1; default max(1, os.availableParallelism() - 1)
}
