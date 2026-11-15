import { getDB } from "./keyDatabase";

// Derived local state: never include this fence in portable backup metadata.
export const CACHED_SEARCH_EPOCH_KEY = "cached_search_epoch:v1";
export function cachedSearchEpoch(value: unknown): string {
  if (value === undefined || value === null) return "initial";
  if (typeof value !== "string" || !value || value.length > 128) throw new Error("search_cache_epoch_invalid");
  return value;
}
export async function getCachedSearchEpoch(): Promise<string> {
  const db = await getDB();
  return cachedSearchEpoch(await db.get("metadata", CACHED_SEARCH_EPOCH_KEY));
}
