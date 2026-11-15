import { getDB } from "./keyDatabase";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";

// Derived local state: never include this fence in portable backup metadata.
export const CACHED_SEARCH_EPOCH_KEY = "cached_search_epoch:v1";
let resetGeneration = 0;
const resetListeners = new Set<() => void>();
let observed: { ownerId: string | null; generation: number; sourceName: string; epoch: string } | undefined;
const emitReset = () => {
  resetGeneration++;
  for (const listener of [...resetListeners]) {
    try { listener(); } catch { console.error("[e2ee] Search reset observer failed"); }
  }
};
export const getCachedSearchResetGeneration = () => resetGeneration;
export function subscribeCachedSearchResets(listener: () => void) { resetListeners.add(listener); return () => { resetListeners.delete(listener); }; }
let channel: BroadcastChannel | undefined;
try {
  if (typeof window !== "undefined" && typeof window.BroadcastChannel === "function") channel = new window.BroadcastChannel("hichat.search-reset.v1");
} catch { /* Persistent epoch checks still fence unsupported contexts. */ }
if (channel) channel.onmessage = event => {
  const sourceName = (event.data as { sourceName?: unknown } | null)?.sourceName;
  if (typeof sourceName !== "string" || sourceName.length > 256) return;
  const scope = getAuthSessionSnapshot();
  void getDB().then(async db => {
    const now = getAuthSessionSnapshot();
    if (scope.ownerId === now.ownerId && scope.generation === now.generation && db.name === sourceName) await getCachedSearchEpoch();
  }).catch(() => { /* Foreign/inactive accounts do not own this notification. */ });
};
/** Begin/end local reset notifications clear visible search results. A committed
 * epoch avoids treating the next ordinary query as another reset.
 */
export function notifyCachedSearchReset(sourceName: string, local = true, epoch?: string) {
  if (local) {
    if (epoch !== undefined) observed = { ...getAuthSessionSnapshot(), sourceName, epoch };
    emitReset();
  }
  try { channel?.postMessage({ sourceName }); } catch { /* Epoch reads remain authoritative. */ }
}
export function cachedSearchEpoch(value: unknown): string {
  if (value === undefined || value === null) return "initial";
  if (typeof value !== "string" || !value || value.length > 128) throw new Error("search_cache_epoch_invalid");
  return value;
}
export async function getCachedSearchEpoch(): Promise<string> {
  const scope = getAuthSessionSnapshot();
  const db = await getDB();
  const epoch = cachedSearchEpoch(await db.get("metadata", CACHED_SEARCH_EPOCH_KEY));
  const now = getAuthSessionSnapshot();
  if (scope.ownerId !== now.ownerId || scope.generation !== now.generation) throw new Error("e2ee_account_scope_changed");
  const changed = observed?.ownerId === scope.ownerId && observed.generation === scope.generation && observed.sourceName === db.name && observed.epoch !== epoch;
  observed = { ...scope, sourceName: db.name, epoch };
  if (changed) emitReset();
  return epoch;
}
