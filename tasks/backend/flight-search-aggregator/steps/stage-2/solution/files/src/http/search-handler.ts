// Stand-ins for the HTTP routes POST /search and GET /search/:id/offers (the real app mounts these
// in its web framework).
import { SearchNotFoundError, ValidationError } from "../errors.ts";
import type { FlightSearchService, PageOptions } from "../search-service.ts";
import type { SearchRequest } from "../types.ts";

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface PageQuery extends PageOptions {
  searchId: string;
}

export async function handleSearch(service: FlightSearchService, body: unknown): Promise<HttpResponse> {
  try {
    const result = await service.searchWithStatus(body as SearchRequest);
    if (result.suppliers.every((s) => s.status !== "ok")) {
      // Couldn't ask anyone: that is not the same as "there are no flights".
      return { status: 503, body: { error: "no supplier available", searchId: result.searchId, suppliers: result.suppliers } };
    }
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof ValidationError) return { status: 400, body: { error: err.message } };
    return { status: 500, body: { error: "internal error" } };
  }
}

export async function handleGetPage(service: FlightSearchService, query: PageQuery): Promise<HttpResponse> {
  if (typeof query !== "object" || query === null) return { status: 400, body: { error: "query must be an object" } };
  try {
    const { searchId, ...options } = query;
    return { status: 200, body: await service.getPage(searchId, options) };
  } catch (err) {
    if (err instanceof ValidationError) return { status: 400, body: { error: err.message } };
    if (err instanceof SearchNotFoundError) return { status: 404, body: { error: err.message } };
    return { status: 500, body: { error: "internal error" } };
  }
}
