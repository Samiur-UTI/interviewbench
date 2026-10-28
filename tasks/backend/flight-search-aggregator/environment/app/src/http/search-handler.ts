// Stands in for the HTTP route POST /search (the real app mounts this in its web framework).
import { ValidationError } from "../errors.ts";
import type { FlightSearchService } from "../search-service.ts";
import type { SearchRequest } from "../types.ts";

export interface HttpResponse {
  status: number;
  body: unknown;
}

export async function handleSearch(service: FlightSearchService, body: unknown): Promise<HttpResponse> {
  try {
    const itineraries = await service.search(body as SearchRequest);
    return { status: 200, body: { itineraries } };
  } catch (err) {
    if (err instanceof ValidationError) return { status: 400, body: { error: err.message } };
    return { status: 502, body: { error: "supplier error" } };
  }
}
