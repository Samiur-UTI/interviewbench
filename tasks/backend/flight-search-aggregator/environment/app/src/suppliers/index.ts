import { SupplierPayloadError } from "../errors.ts";
import type { Itinerary, SupplierFormat } from "../types.ts";
import { parseCaravel } from "./caravel.ts";
import { parseKeystone } from "./keystone.ts";
import { parseTessera } from "./tessera.ts";

export { parseCaravel } from "./caravel.ts";
export { parseKeystone } from "./keystone.ts";
export { parseTessera } from "./tessera.ts";
export type { SupplierClient } from "./types.ts";

function parseFormat(format: SupplierFormat, raw: string, supplier: string): Itinerary[] {
  switch (format) {
    case "caravel":
      return parseCaravel(raw, supplier);
    case "tessera":
      return parseTessera(raw, supplier);
    case "keystone":
      return parseKeystone(raw, supplier);
    default:
      throw new SupplierPayloadError(`unknown supplier format: ${String(format)}`);
  }
}

/**
 * Turns one supplier's raw response into itineraries, each with its own id. Throws
 * SupplierPayloadError if unreadable. An offer the supplier repeats word for word is kept once;
 * two different offers under one reference are a supplier error.
 */
export function parsePayload(format: SupplierFormat, raw: string, supplier: string): Itinerary[] {
  const byId = new Map<string, Itinerary>();
  for (const it of parseFormat(format, raw, supplier)) {
    const seen = byId.get(it.id);
    if (!seen) byId.set(it.id, it);
    else if (JSON.stringify(seen) !== JSON.stringify(it)) throw new SupplierPayloadError(`${supplier}: two different offers with reference ${it.supplierRef}`);
  }
  return [...byId.values()];
}
