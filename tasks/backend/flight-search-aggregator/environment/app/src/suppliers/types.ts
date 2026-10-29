import type { SearchRequest, SupplierFormat } from "../types.ts";

/** A connection to one fare supplier. Real clients do HTTP; tests use fakes. */
export interface SupplierClient {
  readonly name: string; // unique per service
  readonly format: SupplierFormat;
  /** Resolves with the supplier's raw response body. */
  search(req: SearchRequest, signal?: AbortSignal): Promise<string>;
}
