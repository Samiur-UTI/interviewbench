export type SupplierFormat = "aerolink" | "skymesh";
export type TripType = "oneway" | "return" | "multicity";

/** One requested leg: airport codes ("LHR") and a local date ("YYYY-MM-DD"). */
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
  totalPrice: number; // integer US cents, all passengers, all taxes
  seatsAvailable: number;
  durationMinutes: number; // sum over journeys of (last arrival - first departure)
}
