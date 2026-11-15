import { openDB, unwrap, type IDBPDatabase, type IDBPTransaction } from "idb";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { SERVER_URL } from "../utils/constants";
import { dmSourceSequence } from "../utils/dmSourceOrder";
import { getAccountDatabaseName } from "./keyDatabase";
import { getCachedSearchEpoch } from "./cachedSearchEpoch";
import { scanCachedSearchReferences } from "./cachedSearchScan";

export const SEARCH_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REFERENCE_WRITE_BATCH_SIZE = 1024;
type OrderIndex = "time" | "sequence" | "rank";
type Header = { id: string; expiresAt: number; total: number; ready: boolean; orderIndex: OrderIndex };
type Reference = { snapshotId: string; messageId: string; time: number; timestamp: number; sequence?: string; rank?: number };
type Mode = "readonly" | "readwrite";
type Transaction<M extends Mode = Mode> = IDBPTransaction<unknown, string[], M>;
// UUID snapshot IDs have a fixed length; no other snapshot can share this prefix.
const prefixRange = (id: string) => IDBKeyRange.bound([id], [id + "\x00"], false, true);

/** One completion promise per bounded batch; native request errors are all
 * observed, including synchronous cancellation midway through queueing puts.
 */
function putReferenceBatch(store: IDBObjectStore, records: readonly Reference[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = records.length;
    if (!remaining) { resolve(); return; }
    const success = () => { if (--remaining === 0) resolve(); };
    const failure = (event: Event) => reject((event.target as IDBRequest).error ?? new Error("search_index_write_failed"));
    try {
      for (const record of records) {
        const request = store.put(record);
        request.onsuccess = success; request.onerror = failure;
      }
    } catch (error) { reject(error); }
  });
}

async function deleteSnapshot(tx: Transaction<"readwrite">, id: string) {
  await Promise.all([tx.objectStore("refs").delete(prefixRange(id)), tx.objectStore("snapshots").delete(id)]);
}

const activeSnapshots = new Map<string, Set<() => Promise<void>>>();
const resets = new Map<string, number>();
async function openSearchDatabase(name: string): Promise<IDBPDatabase> {
  return openDB(name, 1, { upgrade(db) {
    const refs = db.createObjectStore("refs", { keyPath: ["snapshotId", "messageId"] });
    refs.createIndex("time", ["snapshotId", "time", "messageId"]);
    refs.createIndex("sequence", ["snapshotId", "sequence", "timestamp", "messageId"]);
    refs.createIndex("rank", ["snapshotId", "rank"], { unique: true });
    db.createObjectStore("snapshots", { keyPath: "id" }).createIndex("expires", "expiresAt");
  } });
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

/** Account/backend-scoped, disposable ordering index. Only public message IDs
 * and ordering metadata are written; query text and plaintext are never stored.
 * Keep this separate from the v1 key DB: its v2 is a retirement barrier.
 */
export async function createCachedSearchSnapshot(kind: "channel" | "dm", channelId: string, query: string, signal?: AbortSignal) {
  const scope = getAuthSessionSnapshot();
  const scopeCurrent = () => { const now = getAuthSessionSnapshot(); return scope.ownerId === now.ownerId && scope.generation === now.generation; };
  const assertScope = () => { if (!scopeCurrent()) throw new Error("e2ee_account_scope_changed"); };
  signal?.throwIfAborted(); assertScope();
  const name = `${await getAccountDatabaseName(scope.ownerId ?? "", SERVER_URL)}.search.v1`;
  signal?.throwIfAborted(); assertScope();
  if (resets.has(name)) throw new Error("search_snapshot_resetting");
  const db = await openSearchDatabase(name);
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const active = new Set<Transaction>();
  let disposed = false, closing: Promise<void> | undefined;
  let sourceEpoch: string | null = null, sourceComplete = false;
  let stopOwner = () => {}, stopGeneration = () => {};
  const dispose = (): Promise<void> => {
    if (closing) return closing;
    disposed = true; controller.abort();
    for (const tx of active) { try { tx.abort(); } catch { /* Already complete. */ } }
    stopOwner(); stopGeneration();
    const owned = activeSnapshots.get(name); owned?.delete(dispose);
    if (!owned?.size) activeSnapshots.delete(name);
    closing = (async () => {
      const tx = db.transaction(["refs", "snapshots"], "readwrite");
      void tx.done.catch(() => {});
      try { await deleteSnapshot(tx, id); await tx.done; }
      catch (error) { try { tx.abort(); } catch { /* Already complete. */ } await tx.done.catch(() => {}); throw error; }
      finally { db.close(); }
    })();
    return closing;
  };
  const assertCurrent = () => {
    assertScope();
    if (disposed) throw new Error("search_snapshot_disposed");
    if (resets.has(name)) throw new Error("search_snapshot_resetting");
  };
  const owned = activeSnapshots.get(name) ?? new Set<() => Promise<void>>();
  owned.add(dispose); activeSnapshots.set(name, owned);
  const assertEpoch = async () => {
    if (!sourceComplete) return;
    const currentEpoch = await getCachedSearchEpoch(); assertCurrent();
    if (currentEpoch !== sourceEpoch) { await dispose(); throw new Error("search_snapshot_cache_reset"); }
  };
  const ownerChanged = () => { if (!scopeCurrent()) void dispose().catch(() => { /* Expiry sweep retries abandoned cleanup. */ }); };
  stopOwner = subscribeAuthOwnerChanges(ownerChanged); stopGeneration = subscribeAuthGenerationChanges(ownerChanged);
  const cancelCreation = () => { controller.abort(signal?.reason); };
  signal?.addEventListener("abort", cancelCreation, { once: true });

  async function transaction<T, M extends Mode>(stores: string[], mode: M, run: (tx: Transaction<M>) => Promise<T>, operationSignal?: AbortSignal): Promise<T> {
    assertCurrent(); operationSignal?.throwIfAborted(); await assertEpoch();
    assertCurrent(); operationSignal?.throwIfAborted();
    const tx = db.transaction(stores, mode); active.add(tx);
    void tx.done.catch(() => {});
    const abort = () => { try { tx.abort(); } catch { /* Already complete. */ } };
    operationSignal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await run(tx);
      assertCurrent(); operationSignal?.throwIfAborted();
      await tx.done; assertCurrent(); operationSignal?.throwIfAborted(); await assertEpoch(); operationSignal?.throwIfAborted(); return result;
    } catch (error) { abort(); await tx.done.catch(() => {}); throw error; }
    finally { active.delete(tx); operationSignal?.removeEventListener("abort", abort); }
  }
  async function header(tx: Transaction): Promise<Header> {
    const value = await tx.objectStore("snapshots").get(id) as Header | undefined;
    assertCurrent();
    if (!value?.ready || value.expiresAt <= Date.now()) throw new Error("search_snapshot_expired");
    return value;
  }
  try {
    assertCurrent(); signal?.throwIfAborted();
    await transaction(["refs", "snapshots"], "readwrite", async tx => {
      let expired = await tx.objectStore("snapshots").index("expires").openCursor(IDBKeyRange.upperBound(Date.now()));
      while (expired) { await deleteSnapshot(tx, (expired.value as Header).id); expired = await expired.continue(); }
      await tx.objectStore("snapshots").put({ id, expiresAt: Date.now() + SEARCH_SNAPSHOT_MAX_AGE_MS, total: 0, ready: false, orderIndex: "time" } satisfies Header);
    }, controller.signal);
    let sequencedCount = 0, legacyCount = 0;
    let pendingReferences: Reference[] = [];
    const flushReferences = async () => {
      if (!pendingReferences.length) return;
      const records = pendingReferences;
      pendingReferences = [];
      await transaction(["refs"], "readwrite", async tx => {
        await putReferenceBatch(unwrap(tx.objectStore("refs")), records);
      }, controller.signal);
    };
    const total = await scanCachedSearchReferences(kind, channelId, query, async batch => {
      assertCurrent(); controller.signal.throwIfAborted();
      // Keep the coherent source scan's small delivery batches while amortizing
      // disposable sidecar commits with a separately bounded metadata buffer.
      const records = batch.map(ref => {
        if (!Number.isFinite(ref.timestamp)) throw new Error("search_snapshot_invalid_timestamp");
        const sequence = kind === "dm" ? dmSourceSequence(ref.sourceSequence) : null;
        if (sequence === null) legacyCount++; else sequencedCount++;
        return { snapshotId: id, messageId: ref.messageId, timestamp: ref.timestamp,
          time: kind === "channel" ? -ref.timestamp : ref.timestamp,
          ...(sequence === null ? {} : { sequence: String(sequence).padStart(19, "0") }) } satisfies Reference;
      });
      for (const record of records) {
        pendingReferences.push(record);
        if (pendingReferences.length === REFERENCE_WRITE_BATCH_SIZE) await flushReferences();
      }
    }, controller.signal, epoch => { sourceEpoch = epoch; });
    await flushReferences();
    sourceComplete = true;
    // Pure legacy and pure authoritative histories already have an ordered
    // index. Materialize ranks only for mixed histories, preserving legacy slots.
    const mixed = kind === "dm" && legacyCount > 0 && sequencedCount > 0;
    await transaction(["refs", "snapshots"], "readwrite", async tx => {
      const refs = tx.objectStore("refs");
      if (mixed) {
        let baseline = await refs.index("time").openCursor(prefixRange(id), "prev");
        let sequenced = await refs.index("sequence").openCursor(prefixRange(id), "prev");
        let position = 0;
        while (baseline) {
          const ref = baseline.value as Reference;
          const chosen = ref.sequence === undefined ? ref : sequenced!.value as Reference;
          // Updating rank leaves both active cursor indexes unchanged.
          await refs.put({ ...chosen, rank: -position++ });
          if (ref.sequence !== undefined) sequenced = await sequenced!.continue();
          baseline = await baseline.continue();
        }
      }
      const stored = await tx.objectStore("snapshots").get(id) as Header;
      const orderIndex: OrderIndex = mixed ? "rank" : kind === "dm" && sequencedCount > 0 ? "sequence" : "time";
      await tx.objectStore("snapshots").put({ ...stored, total, ready: true, orderIndex });
    }, controller.signal);
    return {
      async page(offset: number, limit: number, operationSignal?: AbortSignal) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("search_snapshot_invalid_page");
        return transaction(["snapshots", "refs"], "readonly", async tx => {
          const { total, orderIndex } = await header(tx);
          const actualOffset = Math.min(offset, Math.max(0, Math.floor((total - 1) / limit) * limit));
          const ids: string[] = [];
          let cursor = await tx.objectStore("refs").index(orderIndex).openCursor(prefixRange(id), kind === "dm" ? "prev" : "next");
          if (cursor && actualOffset) cursor = await cursor.advance(actualOffset);
          while (cursor && ids.length < limit) { ids.push((cursor.value as Reference).messageId); cursor = await cursor.continue(); }
          return { ids, offset: actualOffset, total };
        }, operationSignal);
      },
      /** Reconcile a bounded pending frontier without a transaction/epoch read
       * for every ID. Duplicate and absent IDs never decrement the total.
       * Positions are unnecessary here: callers reread the reconciled page.
       */
      async removeMany(messageIds: readonly string[], operationSignal?: AbortSignal) {
        if (messageIds.length > 128) throw new Error("search_snapshot_invalid_removal_batch");
        const unique = [...new Set(messageIds)];
        return transaction(["snapshots", "refs"], "readwrite", async tx => {
          const stored = await header(tx), refs = tx.objectStore("refs");
          const found = await Promise.all(unique.map(async messageId => refs.get([id, messageId])));
          const present = unique.filter((_, index) => found[index] !== undefined);
          // Async callbacks observe every request even if cancellation makes a
          // later delete throw synchronously while an earlier one is pending.
          try { await Promise.all(present.map(async messageId => refs.delete([id, messageId]))); }
          catch (error) { operationSignal?.throwIfAborted(); throw error; }
          const total = stored.total - present.length;
          if (present.length) await tx.objectStore("snapshots").put({ ...stored, total });
          return { removed: present.length, total };
        }, operationSignal);
      },
      async remove(messageId: string, operationSignal?: AbortSignal) {
        return transaction(["snapshots", "refs"], "readwrite", async tx => {
          const stored = await header(tx), refs = tx.objectStore("refs");
          const ref = await refs.get([id, messageId]) as Reference | undefined;
          if (!ref) return { removed: false as const, total: stored.total };
          const key = stored.orderIndex === "rank" ? [id, ref.rank!] : stored.orderIndex === "sequence" ?
            [id, ref.sequence!, ref.timestamp, ref.messageId] : [id, ref.time, ref.messageId];
          const before = kind === "dm" ? IDBKeyRange.bound(key, [id + "\x00"], true, true) : IDBKeyRange.bound([id], key, false, true);
          const position = await refs.index(stored.orderIndex).count(before);
          await refs.delete([id, messageId]);
          await tx.objectStore("snapshots").put({ ...stored, total: stored.total - 1 });
          return { removed: true as const, position, total: stored.total - 1 };
        }, operationSignal);
      },
      dispose,
    };
  } catch (error) { await dispose().catch(() => {}); throw error; }
  finally { signal?.removeEventListener("abort", cancelCreation); }
}

export type CachedSearchSnapshot = Awaited<ReturnType<typeof createCachedSearchSnapshot>>;
