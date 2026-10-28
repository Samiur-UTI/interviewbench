const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Converts a USD amount as sent by a supplier ("578.68", "35.00", "500") to integer cents
 * (1 USD = 100 cents). Every price inside the service is an integer number of cents.
 *
 * Parses the digits as integers: never through a float, where "578.68" * 100 is
 * 57867.99999999999. Anything that isn't plain digits with at most 2 decimals throws.
 */
export function toMinorUnits(amount: string): number {
  const m = typeof amount === "string" ? AMOUNT.exec(amount) : null;
  if (!m) throw new Error(`not a USD amount with at most 2 decimals: ${JSON.stringify(amount)}`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error(`amount out of range: ${amount}`);
  return cents;
}
