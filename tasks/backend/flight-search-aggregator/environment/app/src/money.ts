/**
 * Converts a USD amount as sent by a supplier ("1406.80", "3.50", "0.00") to integer cents
 * (1 USD = 100 cents). Every price inside the service is an integer number of cents.
 */
export function toMinorUnits(amount: string): number {
  return Math.floor(parseFloat(amount) * 100);
}
