import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db/schema.ts";
import { SearchStore } from "./db/search-store.ts";
import type { Offer } from "./db/search-store.ts";
import { SearchNotFoundError, ValidationError } from "./errors.ts";
import { mergeItineraries } from "./merge.ts";
import { decodeCursor, encodeCursor, validateLimit, validateSort } from "./paging.ts";
import type { Position } from "./paging.ts";
import { WorkerPool } from "./parsing/worker-pool.ts";
import type { SupplierClient } from "./suppliers/types.ts";
import type { Itinerary, SearchRequest, SortPreference } from "./types.ts";
import { validateSearchRequest } from "./validate.ts";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 30_000;

export interface SupplierStatus {
  supplier: string; // SupplierClient.name
  status: "ok" | "error" | "timeout";
  offers: number; // itineraries parsed from this supplier, before seat filtering and de-duplication
  error?: string; // short message when status is "error"
}

export interface Page {
  offers: Offer[];
  nextCursor: string | null; // null on the last page
}

export interface SearchResult {
  searchId: string;
  partial: boolean; // true if any supplier is not "ok"
  suppliers: SupplierStatus[]; // one per client, in client order
  total: number; // offers stored for this search
  page: Page; // first page, in the request's sort order
}

export interface SearchOptions {
  timeoutMs?: number; // deadline for waiting on suppliers, integer 1..30000
  limit?: number; // size of the first page, integer 1..200, default 50
}

export interface PageOptions {
  sort?: SortPreference; // default "cheapest"
  cursor?: string; // nextCursor of the previous page, in the same sort
  limit?: number; // integer 1..200, default 50
}

export interface ServiceOptions {
  dbPath: string; // database file; opened with the data team's settings (src/db/schema.ts)
  defaultTimeoutMs?: number; // default 8000
  parserThreads?: number; // integer >= 1, default: one less than the available cores (at least 1)
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

function validateParserThreads(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ValidationError("parserThreads must be an integer >= 1");
  }
  return value as number;
}

function requirePreferredCarrier(sort: SortPreference, preferredCarrier: string | null | undefined): void {
  if (sort === "preferred_airline" && !preferredCarrier) {
    throw new ValidationError("the preferred_airline sort needs a search with a preferredCarrier");
  }
}

export class FlightSearchService {
  readonly #clients: readonly SupplierClient[];
  readonly #defaultTimeoutMs: number;
  readonly #db: DatabaseSync;
  readonly #store: SearchStore;
  readonly #pool: WorkerPool;
  #closed = false;

  /** `clients` are asked in parallel; their order is the supplier preference order. */
  constructor(clients: SupplierClient[], options: ServiceOptions) {
    if (!Array.isArray(clients) || clients.length === 0) {
      throw new ValidationError("at least one supplier client is required");
    }
    const names = new Set(clients.map((c) => c.name));
    if (names.size !== clients.length) throw new ValidationError("supplier client names must be unique");
    this.#clients = [...clients];
    this.#defaultTimeoutMs = validateTimeoutMs(options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, "defaultTimeoutMs");
    // Leave one core for the event loop; threads start lazily, on the first search.
    const threads = validateParserThreads(options?.parserThreads ?? Math.max(1, availableParallelism() - 1));
    this.#db = openDatabase(options?.dbPath);
    this.#store = new SearchStore(this.#db);
    this.#pool = new WorkerPool(threads);
  }

  /** Stops the parser threads and closes the database, so the process can exit. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.close();
    this.#db.close();
  }

  /**
   * Asks every supplier, stores what will be shown and returns the first page. Suppliers that
   * fail or miss the deadline are reported in `suppliers` and the rest are still stored
   * (`partial: true`). When every supplier fails the search is stored as failed, with no offers,
   * and the caller decides what that means (HTTP: 503). Resolves only after everything is
   * committed, because booking reads the offers from the database.
   */
  async searchWithStatus(req: SearchRequest, options: SearchOptions = {}): Promise<SearchResult> {
    this.#assertOpen();
    validateSearchRequest(req);
    const sort = validateSort(req.sort ?? "cheapest");
    requirePreferredCarrier(sort, req.preferredCarrier);
    const timeoutMs = validateTimeoutMs(options?.timeoutMs ?? this.#defaultTimeoutMs);
    const limit = validateLimit(options?.limit);
    const seatsNeeded = req.passengers.adults + req.passengers.children;

    const outcomes = await this.#fanOut(req, timeoutMs);

    // Parsing starts after the wait, so the deadline covers waiting for suppliers, not our own
    // work. Payloads are parsed in parallel on the parser threads, off the event loop.
    const clients = this.#clients;
    const parsed = await Promise.all(
      outcomes.map((outcome, i) =>
        outcome.kind === "ok"
          ? this.#pool.parse(clients[i].format, outcome.raw, clients[i].name).then(
              (itineraries): Outcome | Itinerary[] => itineraries,
              (error): Outcome => ({ kind: "error", error }),
            )
          : outcome,
      ),
    );
    this.#assertOpen();

    const suppliers: SupplierStatus[] = [];
    const lists: Itinerary[][] = [];
    parsed.forEach((result, i) => {
      const supplier = clients[i].name;
      if (Array.isArray(result)) {
        suppliers.push({ supplier, status: "ok", offers: result.length });
        lists.push(result.filter((it) => it.seatsAvailable >= seatsNeeded));
      } else if (result.kind === "timeout") {
        suppliers.push({ supplier, status: "timeout", offers: 0 });
      } else if (result.kind === "error") {
        suppliers.push({ supplier, status: "error", offers: 0, error: message(result.error) });
      }
    });
    const offers = mergeItineraries(lists, clients.map((c) => c.name));

    const searchId = randomUUID();
    const failed = suppliers.every((s) => s.status !== "ok");
    this.#store.saveSearch({
      searchId,
      createdAtMs: Date.now(),
      request: req,
      status: failed ? "failed" : "complete",
      suppliers,
      offers,
    });
    return {
      searchId,
      partial: suppliers.some((s) => s.status !== "ok"),
      suppliers,
      total: offers.length,
      page: this.#page(searchId, sort, null, limit),
    };
  }

  /** One page of a stored search. Works on any service using the same database. */
  async getPage(searchId: string, options: PageOptions = {}): Promise<Page> {
    this.#assertOpen();
    if (typeof searchId !== "string") throw new ValidationError("searchId must be a string");
    const sort = validateSort(options?.sort ?? "cheapest");
    const limit = validateLimit(options?.limit);
    const search = this.#store.findSearch(searchId);
    if (!search) throw new SearchNotFoundError(searchId);
    requirePreferredCarrier(sort, search.preferredCarrier);
    const after = options?.cursor === undefined ? null : decodeCursor(options.cursor, searchId, sort);
    return this.#page(searchId, sort, after, limit);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("FlightSearchService is closed");
  }

  #page(searchId: string, sort: SortPreference, after: Position | null, limit: number): Page {
    const { offers, next } = this.#store.readPage(searchId, sort, after, limit);
    return { offers, nextCursor: next && encodeCursor(searchId, sort, next) };
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
