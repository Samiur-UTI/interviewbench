import { SupplierPayloadError } from "./errors.ts";

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?[+-]\d{2}:\d{2}$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_OFFSET = /^([+-])(\d{2}):(\d{2})$/;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** "2026-12-01T22:30:00.000+04:00" -> "2026-12-01T18:30:00.000Z" */
export function toUtcIso(isoWithOffset: string): string {
  if (typeof isoWithOffset !== "string" || !ISO_WITH_OFFSET.test(isoWithOffset)) {
    throw new SupplierPayloadError(`bad time: ${JSON.stringify(isoWithOffset)}`);
  }
  const ms = Date.parse(isoWithOffset);
  if (Number.isNaN(ms)) throw new SupplierPayloadError(`bad time: ${isoWithOffset}`);
  return new Date(ms).toISOString();
}

/** "+05:30" -> 330, "-05:00" -> -300 */
export function offsetMinutes(offset: string): number {
  const m = typeof offset === "string" ? UTC_OFFSET.exec(offset) : null;
  if (!m || Number(m[3]) > 59) throw new SupplierPayloadError(`bad UTC offset: ${JSON.stringify(offset)}`);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** A local date and time without offset, plus the offset of that place: ("2026-12-02T06:15:00", "+05:30") -> "2026-12-02T00:45:00.000Z" */
export function localToUtcIso(localDateTime: string, offset: string): string {
  const m = typeof localDateTime === "string" ? LOCAL_DATE_TIME.exec(localDateTime) : null;
  if (!m) throw new SupplierPayloadError(`bad local time: ${JSON.stringify(localDateTime)}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(local);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new SupplierPayloadError(`bad local time: ${localDateTime}`);
  }
  return new Date(local - offsetMinutes(offset) * MINUTE).toISOString();
}

/** ("2026-12-01", 1) -> "2026-12-02" */
export function addDays(date: string, days: number): string {
  const m = typeof date === "string" ? DATE.exec(date) : null;
  if (!m) throw new SupplierPayloadError(`bad date: ${JSON.stringify(date)}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * DAY).toISOString().slice(0, 10);
}

/** Whole minutes from one ISO instant to another. */
export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / MINUTE);
}
