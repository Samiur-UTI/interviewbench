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
    const result = await service.searchWithStatus(body as SearchRequest);
    if (result.suppliers.every((s) => s.status !== "ok")) {
      // Couldn't ask anyone: that is not the same as "there are no flights".
      return { status: 503, body: { error: "no supplier available", suppliers: result.suppliers } };
    }
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof ValidationError) return { status: 400, body: { error: err.message } };
    return { status: 500, body: { error: "internal error" } };
  }
}
