// PostgreSQL's cursor uses (created_at, id). Date.parse truncates sub-millisecond
// precision; Go can serialize timestamps within the same millisecond.
export function compareMessageTimestamps(left: string, right: string): number {
  if (left === right) return 0;
  const millis = Date.parse(left) - Date.parse(right);
  if (Number.isNaN(millis)) return left.localeCompare(right);
  if (millis) return millis;
  const fraction = (value: string) => (value.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0");
  const a = fraction(left);
  const b = fraction(right);
  return a === b ? 0 : a < b ? -1 : 1;
}
