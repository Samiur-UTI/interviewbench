import { ValidationError } from "./errors.ts";
import { mergeItineraries } from "./merge.ts";
import { parsePayload } from "./suppliers/index.ts";
import type { SupplierClient } from "./suppliers/types.ts";
import type { Itinerary, SearchRequest } from "./types.ts";
import { validateSearchRequest } from "./validate.ts";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 30_000;

export interface SupplierStatus {
  supplier: string; // SupplierClient.name
  status: "ok" | "error" | "timeout";
  offers: number; // itineraries parsed from this supplier, before seat filtering and de-duplication
  error?: string; // short message when status is "error"
}

export interface SearchResult {
  itineraries: Itinerary[]; // cheapest first
  partial: boolean; // true if any supplier is not "ok"
  suppliers: SupplierStatus[]; // one per client, in client order
}

export interface SearchOptions {
  timeoutMs?: number; // deadline for waiting on suppliers, integer 1..30000
}

export interface ServiceOptions {
  defaultTimeoutMs?: number; // default 8000
}

/** How waiting for one supplier ended. */
type Outcome = { kind: "ok"; raw: string } | { kind: "error"; error: unknown } | { kind: "timeout" };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

function validateTimeoutMs(value: unknown, name = "timeoutMs"): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_TIMEOUT_MS) {
    throw new ValidationError(`${name} must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return value as number;
}

export class FlightSearchService {
  readonly #clients: readonly SupplierClient[];
  readonly #defaultTimeoutMs: number;

  /** `clients` are asked in parallel; their order is the supplier preference order. */
  constructor(clients: SupplierClient[], options: ServiceOptions = {}) {
    if (!Array.isArray(clients) || clients.length === 0) {
      throw new ValidationError("at least one supplier client is required");
    }
    const names = new Set(clients.map((c) => c.name));
    if (names.size !== clients.length) throw new ValidationError("supplier client names must be unique");
    this.#clients = [...clients];
    this.#defaultTimeoutMs = validateTimeoutMs(options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, "defaultTimeoutMs");
  }

  /**
   * Asks every supplier and merges what they return. Suppliers that fail or miss the deadline
   * are reported in `suppliers` and the rest are still returned (`partial: true`). When every
   * supplier fails, `itineraries` is empty and the caller decides what that means (HTTP: 503).
   */
  async searchWithStatus(req: SearchRequest, options: SearchOptions = {}): Promise<SearchResult> {
    validateSearchRequest(req);
    const timeoutMs = validateTimeoutMs(options?.timeoutMs ?? this.#defaultTimeoutMs);
    const seatsNeeded = req.passengers.adults + req.passengers.children;

    const outcomes = await this.#fanOut(req, timeoutMs);

    // Parsing happens after the wait: the deadline covers waiting for suppliers, not our own work.
    const clients = this.#clients;
    const suppliers: SupplierStatus[] = [];
    const lists: Itinerary[][] = [];
    outcomes.forEach((outcome, i) => {
      const supplier = clients[i].name;
      if (outcome.kind === "timeout") {
        suppliers.push({ supplier, status: "timeout", offers: 0 });
      } else if (outcome.kind === "error") {
        suppliers.push({ supplier, status: "error", offers: 0, error: message(outcome.error) });
      } else {
        try {
          const parsed = parsePayload(clients[i].format, outcome.raw, supplier);
          suppliers.push({ supplier, status: "ok", offers: parsed.length });
          lists.push(parsed.filter((it) => it.seatsAvailable >= seatsNeeded));
        } catch (err) {
          suppliers.push({ supplier, status: "error", offers: 0, error: message(err) });
        }
      }
    });
    return {
      itineraries: mergeItineraries(lists, clients.map((c) => c.name)),
      partial: suppliers.some((s) => s.status !== "ok"),
      suppliers,
    };
  }

  /**
   * Calls every supplier at once, each with its own AbortController, and waits until each has
   * answered or the shared deadline passes. Suppliers still pending at the deadline are aborted;
   * whatever they do later is ignored. The timer is always cleared before this settles.
   */
  async #fanOut(req: SearchRequest, timeoutMs: number): Promise<Outcome[]> {
    const clients = this.#clients;
    const controllers = clients.map(() => new AbortController());
    const answered = clients.map(() => false);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });

    const waits = clients.map((client, i) => {
      let call: Promise<string>;
      try {
        call = Promise.resolve(client.search(req, controllers[i].signal));
      } catch (err) {
        call = Promise.reject(err);
      }
      // Both branches are handled here, so a late rejection is never unhandled.
      const answer = call.then(
        (raw): Outcome =>
          typeof raw === "string" ? { kind: "ok", raw } : { kind: "error", error: new Error("response body is not a string") },
        (error): Outcome => ({ kind: "error", error }),
      );
      return Promise.race([answer, deadline]).then((outcome) => {
        answered[i] = outcome.kind !== "timeout";
        return outcome;
      });
    });

    try {
      return await Promise.all(waits);
    } finally {
      clearTimeout(timer);
      const reason = new Error(`supplier timed out after ${timeoutMs} ms`);
      controllers.forEach((c, i) => {
        if (!answered[i]) c.abort(reason);
      });
    }
  }
}
