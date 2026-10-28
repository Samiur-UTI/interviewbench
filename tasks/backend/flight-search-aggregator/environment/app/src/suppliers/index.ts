import { SupplierPayloadError } from "../errors.ts";
import type { Itinerary, SupplierFormat } from "../types.ts";
import { parseAeroLink } from "./aerolink.ts";
import { parseSkyMesh } from "./skymesh.ts";

export { parseAeroLink } from "./aerolink.ts";
export { parseSkyMesh } from "./skymesh.ts";
export type { SupplierClient } from "./types.ts";

/** Turns one supplier's raw response into itineraries. Throws SupplierPayloadError if unreadable. */
export function parsePayload(format: SupplierFormat, raw: string, supplier: string): Itinerary[] {
  switch (format) {
    case "aerolink":
      return parseAeroLink(raw, supplier);
    case "skymesh":
      return parseSkyMesh(raw, supplier);
    default:
      throw new SupplierPayloadError(`unknown supplier format: ${String(format)}`);
  }
}
