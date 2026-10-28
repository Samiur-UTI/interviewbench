import { availableParallelism } from "node:os";
import { NoSuppliersAvailableError, ValidationError } from "./errors.ts";
import { mergeItineraries } from "./merge.ts";
import { WorkerPool } from "./parsing/worker-pool.ts";
import type { SupplierClient } from "./suppliers/types.ts";
import type { Itinerary, SearchOptions, SearchRequest, SearchResult, ServiceOptions, SupplierStatus } from "./types.ts";
import { validateParserThreads, validateSearchRequest, validateTimeoutMs } from "./validate.ts";

const DEFAULT_TIMEOUT_MS = 8000;

/** How waiting for one supplier ended. */
type Outcome = { kind: "ok"; raw: string } | { kind: "error"; error: unknown } | { kind: "timeout" };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

export class FlightSearchService {
  readonly #clients: readonly SupplierClient[];
  readonly #defaultTimeoutMs: number;
  readonly #pool: WorkerPool;
  #closed = false;

  /** `clients` are asked in parallel; their order is the supplier preference order. */
  constructor(clients: SupplierClient[], options: ServiceOptions = {}) {
    if (!Array.isArray(clients) || clients.length === 0) {
      throw new ValidationError("at least one supplier client is required");
    }
    const names = new Set(clients.map((c) => c.name));
    if (names.size !== clients.length) throw new ValidationError("supplier client names must be unique");
    this.#clients = [...clients];
    this.#defaultTimeoutMs = validateTimeoutMs(options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, "defaultTimeoutMs");
    // Leave one core for the event loop; threads start lazily, on the first search.
    const threads = options?.parserThreads ?? Math.max(1, availableParallelism() - 1);
    this.#pool = new WorkerPool(validateParserThreads(threads));
  }

  /** Stops the parser threads so the process can exit. Later searches reject. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#pool.close();
  }

  /** Partial results when some suppliers fail; rejects with NoSuppliersAvailableError if all do. */
  async search(req: SearchRequest): Promise<Itinerary[]> {
    const result = await this.searchWithStatus(req);
    if (result.suppliers.every((s) => s.status !== "ok")) throw new NoSuppliersAvailableError(result.suppliers);
    return result.itineraries;
  }

  async searchWithStatus(req: SearchRequest, options: SearchOptions = {}): Promise<SearchResult> {
    if (this.#closed) throw new Error("FlightSearchService is closed");
    validateSearchRequest(req);
    const timeoutMs = validateTimeoutMs(options?.timeoutMs ?? this.#defaultTimeoutMs);
    const signal = options?.signal;
    signal?.throwIfAborted();

    const outcomes = await this.#fanOut(req, timeoutMs, signal);

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
    signal?.throwIfAborted();

    const suppliers: SupplierStatus[] = [];
    const lists: Itinerary[][] = [];
    parsed.forEach((result, i) => {
      const supplier = clients[i].name;
      if (Array.isArray(result)) {
        suppliers.push({ supplier, status: "ok", offers: result.length });
        lists.push(result.filter((it) => it.seatsAvailable >= req.passengers));
      } else if (result.kind === "timeout") {
        suppliers.push({ supplier, status: "timeout", offers: 0 });
      } else if (result.kind === "error") {
        suppliers.push({ supplier, status: "error", offers: 0, error: message(result.error) });
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
   * answered or the shared deadline passes. Suppliers still pending at the deadline (or when the
   * caller aborts) are aborted; whatever they do later is ignored. The timer and the listener on
   * the caller's signal are always removed before this settles.
   */
  async #fanOut(req: SearchRequest, timeoutMs: number, signal: AbortSignal | undefined): Promise<Outcome[]> {
    const clients = this.#clients;
    const controllers = clients.map(() => new AbortController());
    const answered = clients.map(() => false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const deadline = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      if (!signal) return;
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
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
      return await Promise.race([Promise.all(waits), cancelled]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      const reason = signal?.aborted ? signal.reason : new Error(`supplier timed out after ${timeoutMs} ms`);
      controllers.forEach((c, i) => {
        if (!answered[i]) c.abort(reason);
      });
    }
  }
}
