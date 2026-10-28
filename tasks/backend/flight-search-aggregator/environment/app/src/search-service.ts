import { ValidationError } from "./errors.ts";
import { mergeItineraries } from "./merge.ts";
import { parsePayload } from "./suppliers/index.ts";
import type { SupplierClient } from "./suppliers/types.ts";
import type { Itinerary, SearchRequest } from "./types.ts";
import { validateSearchRequest } from "./validate.ts";

export class FlightSearchService {
  readonly #clients: readonly SupplierClient[];

  /** `clients` are asked in parallel; their order is the supplier preference order. */
  constructor(clients: SupplierClient[]) {
    if (!Array.isArray(clients) || clients.length === 0) {
      throw new ValidationError("at least one supplier client is required");
    }
    const names = new Set(clients.map((c) => c.name));
    if (names.size !== clients.length) throw new ValidationError("supplier client names must be unique");
    this.#clients = [...clients];
  }

  async search(req: SearchRequest): Promise<Itinerary[]> {
    validateSearchRequest(req);
    const clients = this.#clients;
    const raws = await Promise.all(clients.map((c) => c.search(req)));
    const lists = raws.map((raw, i) =>
      parsePayload(clients[i].format, raw, clients[i].name).filter((it) => it.seatsAvailable >= req.passengers),
    );
    return mergeItineraries(lists, clients.map((c) => c.name));
  }
}
