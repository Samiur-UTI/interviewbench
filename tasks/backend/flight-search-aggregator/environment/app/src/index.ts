// Public API. Other services (and the HTTP layer) import only from here.
export type { Itinerary, Journey, Leg, SearchRequest, Segment, SupplierFormat, TripType } from "./types.ts";
export type { SupplierClient } from "./suppliers/types.ts";
export { SupplierPayloadError, ValidationError } from "./errors.ts";
export { toMinorUnits } from "./money.ts";
export { minutesBetween, parseCompactUtc, toUtcIso } from "./time.ts";
export { validateSearchRequest } from "./validate.ts";
export { parseAeroLink, parsePayload, parseSkyMesh } from "./suppliers/index.ts";
export { compareItineraries, itineraryKey, mergeItineraries } from "./merge.ts";
export { FlightSearchService } from "./search-service.ts";
export { handleSearch } from "./http/search-handler.ts";
export type { HttpResponse } from "./http/search-handler.ts";
