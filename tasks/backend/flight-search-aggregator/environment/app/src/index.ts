// Public API. Other services (and the HTTP layer) import only from here.
export type {
  Cabin,
  Itinerary,
  Journey,
  Leg,
  Passengers,
  PaxPrice,
  PaxType,
  SearchRequest,
  Segment,
  SortPreference,
  SupplierFormat,
  TripType,
} from "./types.ts";
export type { SupplierClient } from "./suppliers/types.ts";
export { SupplierPayloadError, ValidationError } from "./errors.ts";
export { toMinorUnits } from "./money.ts";
export { addDays, localToUtcIso, minutesBetween, toUtcIso } from "./time.ts";
export { validateSearchRequest } from "./validate.ts";
export { parseCaravel, parseKeystone, parsePayload, parseTessera } from "./suppliers/index.ts";
export { compareItineraries, itineraryKey, mergeItineraries } from "./merge.ts";
export { FlightSearchService } from "./search-service.ts";
export { handleSearch } from "./http/search-handler.ts";
export type { HttpResponse } from "./http/search-handler.ts";
