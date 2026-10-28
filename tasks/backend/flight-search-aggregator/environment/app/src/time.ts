import { SupplierPayloadError } from "./errors.ts";

const LOCAL_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?[+-]\d{2}:\d{2}$/;
const COMPACT_UTC = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/** "2026-12-01T21:40:00+06:00" -> "2026-12-01T15:40:00.000Z" */
export function toUtcIso(localWithOffset: string): string {
  if (typeof localWithOffset !== "string" || !LOCAL_WITH_OFFSET.test(localWithOffset)) {
    throw new SupplierPayloadError(`bad local time: ${JSON.stringify(localWithOffset)}`);
  }
  const ms = Date.parse(localWithOffset);
  if (Number.isNaN(ms)) throw new SupplierPayloadError(`bad local time: ${localWithOffset}`);
  return new Date(ms).toISOString();
}

/** "202612011540" (yyyyMMddHHmm, UTC) -> "2026-12-01T15:40:00.000Z" */
export function parseCompactUtc(compact: string): string {
  const m = typeof compact === "string" ? COMPACT_UTC.exec(compact) : null;
  if (!m) throw new SupplierPayloadError(`bad UTC time: ${JSON.stringify(compact)}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59) {
    throw new SupplierPayloadError(`bad UTC time: ${compact}`);
  }
  return date.toISOString();
}

/** Whole minutes from one ISO instant to another. */
export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
}
