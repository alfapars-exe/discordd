import type { DMMessage } from "../types";

/** Server metadata only. Decimal strings preserve the full signed BIGINT range. */
export function dmSourceSequence(value: unknown): bigint | null {
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || value <= 0) return null; value = String(value); }
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  const parsed = BigInt(value); return parsed <= 9223372036854775807n ? parsed : null;
}
/** Keep legacy/optimistic slots in their existing fallback order, and sort all
 * authoritative sequenced slots by append order. This avoids a nontransitive
 * mixed timestamp/sequence comparator while preserving old-server behavior. */
export function sortDMBySource<T extends Pick<DMMessage,"id"|"created_at"|"source_sequence">>(messages: readonly T[], positions?: ReadonlyMap<string,number>): T[] {
  const baseline = [...messages].sort((a,b) => a.created_at.localeCompare(b.created_at) || (positions?.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions?.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const known = baseline.filter(message => dmSourceSequence(message.source_sequence) !== null).sort((a,b) => {
    const left = dmSourceSequence(a.source_sequence)!, right = dmSourceSequence(b.source_sequence)!;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  let index = 0;
  return baseline.map(message => dmSourceSequence(message.source_sequence) === null ? message : known[index++]);
}
export function newerDMSource(next: Pick<DMMessage,"source_sequence"|"created_at">, current?: Pick<DMMessage,"source_sequence"|"created_at"> | null): boolean {
  if (!current) return true;
  const left = dmSourceSequence(next.source_sequence), right = dmSourceSequence(current.source_sequence);
  return left !== null && right !== null ? left >= right : next.created_at >= current.created_at;
}
