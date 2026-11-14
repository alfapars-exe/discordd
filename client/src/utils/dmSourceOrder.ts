import { compareMessageTimestamps } from "./messageTimestamp";
import type { DMMessage } from "../types";

/** Server metadata only. Decimal strings preserve the full signed BIGINT range. */
export function dmSourceSequence(value: unknown): bigint | null {
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || value <= 0) return null; value = String(value); }
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  const parsed = BigInt(value); return parsed <= 9223372036854775807n ? parsed : null;
}
export function preserveDMSourceSequence<T extends Pick<DMMessage, "source_sequence">>(
  current: T | undefined, update: T,
): T {
  if (!current || update.source_sequence !== undefined || dmSourceSequence(current.source_sequence) === null) return update;
  return { ...update, source_sequence: current.source_sequence };
}

/** Keep legacy/optimistic slots in their existing fallback order, and sort all
 * authoritative sequenced slots by append order. This avoids a nontransitive
 * mixed timestamp/sequence comparator while preserving old-server behavior. */
export function sortDMBySource<T extends Pick<DMMessage, "id" | "created_at" | "source_sequence">>(
  messages: readonly T[],
  tieBreak?: ReadonlyMap<string, number> | "id",
): T[] {
  const baseline = [...messages].sort((a, b) => {
    const timeOrder = compareMessageTimestamps(a.created_at, b.created_at);
    if (timeOrder || !tieBreak) return timeOrder;
    if (tieBreak === "id") return a.id.localeCompare(b.id);
    return (tieBreak.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (tieBreak.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  });
  const slots: number[] = [];
  const known: { message: T; sequence: bigint }[] = [];
  baseline.forEach((message, index) => {
    const sequence = dmSourceSequence(message.source_sequence);
    if (sequence !== null) {
      slots.push(index);
      known.push({ message, sequence });
    }
  });
  known.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
  slots.forEach((slot, index) => { baseline[slot] = known[index].message; });
  return baseline;
}
export function newerDMSource(next: Pick<DMMessage,"source_sequence"|"created_at">, current?: Pick<DMMessage,"source_sequence"|"created_at"> | null): boolean {
  if (!current) return true;
  const left = dmSourceSequence(next.source_sequence), right = dmSourceSequence(current.source_sequence);
  return left !== null && right !== null ? left >= right : compareMessageTimestamps(next.created_at, current.created_at) >= 0;
}
