import { SupplierPayloadError } from "./errors.ts";

// Suppliers send USD as decimal strings with exactly 2 decimals ("1406.80", "0.29"). Binary
// floats can't hold most of these exactly (1037.11 * 100 = 103710.99999999999), so the string is
// split into dollars and cents and never goes through a float.
const AMOUNT = /^(0|[1-9]\d*)\.(\d{2})$/;

/**
 * Converts a USD amount as sent by a supplier ("1406.80", "3.50", "0.00") to integer cents
 * (1 USD = 100 cents). Anything else is a SupplierPayloadError: we never guess an amount.
 */
export function toMinorUnits(amount: string): number {
  const m = typeof amount === "string" ? AMOUNT.exec(amount) : null;
  if (!m) throw new SupplierPayloadError(`bad amount: ${JSON.stringify(amount)}`);
  const cents = Number(m[1]) * 100 + Number(m[2]);
  if (!Number.isSafeInteger(cents)) throw new SupplierPayloadError(`amount too large: ${amount}`);
  return cents;
}

/** "USD1406.80" -> 140680. Any other currency is a SupplierPayloadError. */
export function parseUsd(amount: string): number {
  if (typeof amount !== "string" || !amount.startsWith("USD")) {
    throw new SupplierPayloadError(`not a USD amount: ${JSON.stringify(amount)}`);
  }
  return toMinorUnits(amount.slice(3));
}
