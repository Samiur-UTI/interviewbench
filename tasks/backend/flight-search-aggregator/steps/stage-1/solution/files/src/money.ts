const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Converts a BDT amount as sent by a supplier ("41111.13", "3105.00", "500") to integer poisha
 * (1 BDT = 100 poisha). Every price inside the service is an integer number of poisha.
 *
 * Parses the digits as integers: never through a float, where "41111.13" * 100 is
 * 4111112.9999999995. Anything that isn't plain digits with at most 2 decimals throws.
 */
export function toMinorUnits(amount: string): number {
  const m = typeof amount === "string" ? AMOUNT.exec(amount) : null;
  if (!m) throw new Error(`not a BDT amount with at most 2 decimals: ${JSON.stringify(amount)}`);
  const poisha = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(poisha)) throw new Error(`amount out of range: ${amount}`);
  return poisha;
}
