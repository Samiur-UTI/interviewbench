/**
 * Converts a BDT amount as sent by a supplier ("41111.13", "3105.00", "500") to integer poisha
 * (1 BDT = 100 poisha). Every price inside the service is an integer number of poisha.
 */
export function toMinorUnits(amount: string): number {
  return Math.floor(parseFloat(amount) * 100);
}
