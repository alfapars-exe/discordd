import { openDB, type IDBPDatabase } from "idb";

const activeSnapshots = new Map<string, Set<() => Promise<void>>>();
const resets = new Map<string, number>();
export async function openSearchDatabase(name: string): Promise<IDBPDatabase> {
  return openDB(name, 1, { upgrade(db) {
    const refs = db.createObjectStore("refs", { keyPath: ["snapshotId", "messageId"] });
    refs.createIndex("time", ["snapshotId", "time", "messageId"]);
    refs.createIndex("sequence", ["snapshotId", "sequence", "timestamp", "messageId"]);
    refs.createIndex("rank", ["snapshotId", "rank"], { unique: true });
    db.createObjectStore("snapshots", { keyPath: "id" }).createIndex("expires", "expiresAt");
  } });
}

export function isCachedSearchResetting(name: string): boolean { return resets.has(name); }
export function registerCachedSearchResource(name: string, dispose: () => Promise<void>): () => void {
  const owned = activeSnapshots.get(name) ?? new Set<() => Promise<void>>();
  owned.add(dispose); activeSnapshots.set(name, owned);
  return () => {
    owned.delete(dispose);
    if (!owned.size && activeSnapshots.get(name) === owned) activeSnapshots.delete(name);
  };
}

/** Fence local creation for the whole reset, cancel owned work, then clear
 * abandoned/cross-tab indexes too. A source epoch is the cross-tab read fence.
 */
export async function withResetCachedSearchSnapshots<T>(sourceName: string, resetSource: () => Promise<T>, isCurrent: () => boolean = () => true): Promise<T> {
  if (!isCurrent()) throw new Error("e2ee_account_scope_changed");
  const name = `${sourceName}.search.v1`;
  resets.set(name, (resets.get(name) ?? 0) + 1);
  let failed = false, failure: unknown, result: T | undefined;
  try {
    // A final store clear retries cleanup even if one disposed handle failed.
    await Promise.allSettled([...(activeSnapshots.get(name) ?? [])].map(dispose => dispose()));
    if (!isCurrent()) throw new Error("e2ee_account_scope_changed");
    result = await resetSource();
  } catch (error) { failed = true; failure = error; }
  try {
    // Avoid creating a derived database for accounts that never searched.
    if (isCurrent() && (typeof indexedDB.databases !== "function" || (await indexedDB.databases()).some(db => db.name === name))) {
      const db = await openSearchDatabase(name);
      try {
        if (isCurrent()) {
          const tx = db.transaction(["refs", "snapshots"], "readwrite");
          void tx.done.catch(() => {});
          try { await Promise.all([tx.objectStore("refs").clear(), tx.objectStore("snapshots").clear()]); await tx.done; }
          catch (error) { try { tx.abort(); } catch { /* Already complete. */ } await tx.done.catch(() => {}); throw error; }
        }
      } finally { db.close(); }
    }
  } catch (error) {
    if (!failed) { failed = true; failure = error; }
    else console.warn("[e2ee] search index cleanup failed after an unsuccessful key reset");
  } finally {
    const remaining = (resets.get(name) ?? 1) - 1;
    if (remaining) resets.set(name, remaining); else resets.delete(name);
  }
  if (failed) throw failure;
  return result as T;
}

