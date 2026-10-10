/**
 * Message `seq` is a decimal string (a Postgres BigInt, never with leading zeros). Plain string comparison gets
 * "10" < "9" wrong and Number() loses precision past 2^53, so every ordering of messages goes through here:
 * a longer string is a bigger number, equal lengths compare digit by digit.
 */
export function compareSeq(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
